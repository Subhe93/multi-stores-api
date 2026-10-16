import { DesignAssetKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import { DesignerCartService } from './designer-cart.service';
import { designerErrorCode } from './designer-errors';
import type { DesignerFontsService } from './designer-fonts.service';
import { releaseProofKey, replaceDesignProofKey } from './designer-proof-keys';
import {
  DesignerTemplatesService,
  pendingSpecIssues,
} from './designer-templates.service';
import { DesignsService } from './designs.service';
import {
  CUSTOMER,
  FONT,
  PRODUCT,
  STORE,
  TEMPLATE,
  V1,
  asset,
  doubles,
  seededDb,
  templateSpec,
} from './designs.fixtures.mockspec';

// M4.2 fixer A: cart view (invalid / slug / freshness), duplicate, order
// originals, publish validation, linked-template guard, unlink, thumbnails
// and the proof-key helpers.

function build(opts: { appOn?: boolean } = {}) {
  const db = seededDb();
  const d = doubles(db, opts);
  const bytes = new Map<string, Buffer>();
  Object.assign(d.assets, {
    readAssetBytes: jest.fn((a: { id: string; purged_at?: Date | null }) =>
      Promise.resolve(bytes.get(a.id) ?? Buffer.from(`bytes-${a.id}`)),
    ),
    deleteAsset: jest.fn((_s: string, id: string) => {
      const i = db.designAsset.findIndex((x) => x.id === id);
      if (i >= 0) db.designAsset.splice(i, 1);
      return Promise.resolve({ deleted: true });
    }),
  });
  const designs = new DesignsService(
    d.prisma as unknown as PrismaService,
    d.storeApps,
    d.assets,
    d.urls,
  );
  const cart = new DesignerCartService(
    d.prisma as unknown as PrismaService,
    d.storeApps,
    designs,
    d.assets,
    d.urls,
  );
  const fonts = {
    fontsForSpec: jest.fn(
      (_s: string, spec: { fonts?: { asset_id: string }[] }) =>
        Promise.resolve(
          (spec.fonts ?? [])
            .filter((f) => f.asset_id === FONT)
            .map(() => ({
              asset_id: FONT,
              family: 'Montserrat',
              weight: 600,
              style: 'normal',
              url: `/api/designer/fonts/${FONT}.woff2`,
            })),
        ),
    ),
  };
  const templates = new DesignerTemplatesService(
    d.prisma as unknown as PrismaService,
    d.storeApps,
    d.assets,
    fonts as unknown as DesignerFontsService,
    {
      revalidateStoreById: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
  );
  return { db, designs, cart, templates, ...d };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return designerErrorCode(e);
  }
  return 'NO_ERROR';
}

async function completeDesign(
  b: ReturnType<typeof build>,
  customerId: string | null,
) {
  const created = await b.designs.create(
    STORE,
    { product_id: PRODUCT, template_version_id: V1 },
    customerId,
  );
  const access = { customerId, token: created.token };
  const up = await b.designs.uploadPhoto(
    STORE,
    created.id,
    'foto',
    Buffer.from('x'),
    access,
  );
  await b.designs.update(
    STORE,
    created.id,
    {
      state: {
        v: 1,
        texts: { namn: 'Anna' },
        photos: {
          foto: {
            ...up.design.state.photos.foto,
            adj: { zoom: 2, rot: 5, panX: 0.2, panY: 0.8 },
          },
        },
      },
      state_version: up.design.state_version,
    },
    access,
  );
  return { id: created.id, token: created.token, photo: up.asset_id };
}

describe('Cart design block (invalid, product_slug, freshness)', () => {
  it('a valid design: product_slug in the locale, no invalid flag', async () => {
    const b = build();
    b.db.productTranslation.push(
      { product_id: PRODUCT, locale: 'en', slug: 'name-sign' },
      { product_id: PRODUCT, locale: 'sv', slug: 'namnskylt' },
    );
    const d = await completeDesign(b, CUSTOMER);
    const v = (await b.cart.cartDesigns([d.id], 'sv')).get(d.id)!;
    expect(v.product_slug).toBe('namnskylt');
    expect(v).not.toHaveProperty('invalid');
  });

  it.each([
    ['archived template', 'DESIGNER_TEMPLATE_MISMATCH'],
    ['ordered design', 'DESIGNER_DESIGN_LOCKED'],
    ['incomplete state', 'DESIGNER_STATE_INVALID'],
    ['purged photo', 'DESIGNER_STATE_INVALID'],
  ])('%s → invalid with %s', async (what, code) => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    const row = b.db.design.find((x) => x.id === d.id)!;
    if (what === 'archived template')
      b.db.designTemplate[0].status = 'ARCHIVED';
    if (what === 'ordered design') row.status = 'ORDERED';
    if (what === 'incomplete state') {
      row.state = { v: 1, texts: {}, photos: {} };
    }
    if (what === 'purged photo') {
      b.db.designAsset.find((x) => x.id === d.photo)!.purged_at = new Date();
    }
    const v = (await b.cart.cartDesigns([d.id], 'sv')).get(d.id)!;
    expect(v).toMatchObject({ invalid: true, invalid_code: code });
  });

  it('app off → invalid DESIGNER_NOT_ENABLED', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    b.storeApps.isEnabled.mockResolvedValue(false);
    const v = (await b.cart.cartDesigns([d.id])).get(d.id)!;
    expect(v.invalid_code).toBe('DESIGNER_NOT_ENABLED');
  });

  it('reading the cart refreshes updated_at at most once a day (R1 keeps active drafts)', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    const row = b.db.design.find((x) => x.id === d.id)!;
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    row.updated_at = old;
    await b.cart.cartDesigns([d.id]);
    expect((row.updated_at as Date).getTime()).toBeGreaterThan(old.getTime());
    b.prisma.design.updateMany.mockClear();
    await b.cart.cartDesigns([d.id]);
    expect(b.prisma.design.updateMany).not.toHaveBeenCalled();
  });

  it('an order-bound quote refreshes the priced designs too', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    const row = b.db.design.find((x) => x.id === d.id)!;
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    row.updated_at = old;
    await b.cart.planLines(STORE, [{ product_id: PRODUCT, design_id: d.id }], {
      mode: 'quote',
      customerId: CUSTOMER,
      verifiedDesignIds: [],
    });
    expect((row.updated_at as Date).getTime()).toBeGreaterThan(old.getTime());
  });
});

describe('DesignsService.duplicate', () => {
  it('ordered design → new DRAFT, same texts / adjustments, COPIED photo, new token', async () => {
    const b = build();
    b.db.productTranslation.push({
      product_id: PRODUCT,
      locale: 'sv',
      slug: 'namnskylt',
    });
    const d = await completeDesign(b, null);
    b.db.design.find((x) => x.id === d.id)!.status = 'ORDERED';
    const copy = await b.designs.duplicate(STORE, d.id, {
      customerId: null,
      token: d.token,
      locale: 'sv',
    });
    expect(copy.id).not.toBe(d.id);
    expect(copy.token).toBeTruthy();
    expect(copy.token).not.toBe(d.token);
    expect(copy.status).toBe('DRAFT');
    expect(copy.product_slug).toBe('namnskylt');
    expect(copy.state.texts).toEqual({ namn: 'Anna' });
    const photo = copy.state.photos.foto;
    expect(photo.asset_id).not.toBe(d.photo);
    expect(photo.adj).toEqual({ zoom: 2, rot: 5, panX: 0.2, panY: 0.8 });
    // Bytes were read from the original and stored as a new photo row.
    const readBytes = (b.assets as unknown as { readAssetBytes: jest.Mock })
      .readAssetBytes;
    expect(readBytes).toHaveBeenCalledWith(
      expect.objectContaining({ id: d.photo }),
      'original',
    );
    const newRow = b.db.designAsset.find((x) => x.id === photo.asset_id)!;
    expect(newRow).toMatchObject({
      design_id: copy.id,
      kind: DesignAssetKind.CUSTOMER_PHOTO,
    });
    // The copy is a complete, orderable design of its own.
    const [line] = await b.cart.planLines(
      STORE,
      [{ product_id: PRODUCT, design_id: copy.id, design_token: copy.token }],
      { mode: 'quote' },
    );
    expect(line?.design.id).toBe(copy.id);
  });

  it('a purged photo is left out; strangers get 404', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    b.db.designAsset.find((x) => x.id === d.photo)!.purged_at = new Date();
    const copy = await b.designs.duplicate(STORE, d.id, {
      customerId: CUSTOMER,
      token: null,
    });
    expect(copy.state.photos).toEqual({});
    expect(
      await codeOf(
        b.designs.duplicate(STORE, d.id, { customerId: null, token: 'x' }),
      ),
    ).toBe('DESIGNER_DESIGN_NOT_FOUND');
  });
});

describe('Order originals download', () => {
  const ORDER = '99999999-9999-4999-8999-000000000001';
  const ITEM = '99999999-9999-4999-8999-000000000002';

  function withOrder(b: ReturnType<typeof build>, photoId: string) {
    b.db.orderItemDesign.push({
      id: 'oid1',
      store_id: STORE,
      order_id: ORDER,
      order_item_id: ITEM,
      assets: [{ asset_id: photoId, role: 'photo', element_id: 'foto' }],
      originals_purged_at: null,
      files_purged_at: null,
      order_item: { order: { order_number: 'NZ-7' } },
    });
  }

  it('streams the item photo as an attachment; foreign asset 404; purged 410', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    withOrder(b, d.photo);
    const f = await b.cart.orderOriginal(STORE, ORDER, ITEM, d.photo);
    expect(f.filename).toBe('NZ-7-foto-original.jpg');
    expect(f.mime).toBe('image/jpeg');
    expect(
      await codeOf(
        b.cart.orderOriginal(
          STORE,
          ORDER,
          ITEM,
          '88888888-8888-4888-8888-999999999999',
        ),
      ),
    ).toBe('DESIGNER_ASSET_NOT_FOUND');
    b.db.orderItemDesign[0].originals_purged_at = new Date();
    expect(
      await codeOf(b.cart.orderOriginal(STORE, ORDER, ITEM, d.photo)),
    ).toBe('DESIGNER_FILES_PURGED');
  });
});

describe('Templates: publish validation, linked guard, unlink, thumbnails', () => {
  it('pendingSpecIssues: pending assets and fonts', () => {
    const spec = templateSpec();
    spec.surfaces[0].background.print = {
      asset_id: 'pending:bg_print',
      width: 0,
      height: 0,
    };
    spec.fonts[0].asset_id = 'pending:font:Montserrat:600:normal';
    expect(pendingSpecIssues(spec)).toEqual([
      { path: 'surfaces[0].background.print', rule: 'pending_asset' },
      { path: 'fonts[0]', rule: 'missing_font' },
    ]);
  });

  it('publish / enable refuse a version with pending assets → 400 TEMPLATE_INVALID', async () => {
    const b = build();
    const spec = templateSpec();
    spec.surfaces[0].background.web = {
      asset_id: 'pending:bg_web',
      width: 0,
      height: 0,
    };
    b.db.designTemplateVersion.find((v) => v.id === V1)!.spec = spec;
    let err: unknown;
    try {
      await b.templates.publish(STORE, TEMPLATE, V1);
    } catch (e) {
      err = e;
    }
    expect(designerErrorCode(err)).toBe('DESIGNER_TEMPLATE_INVALID');
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      errors: [{ path: 'surfaces[0].background.web', rule: 'pending_asset' }],
    });
    expect(
      await codeOf(
        b.templates.putProductLink(STORE, PRODUCT, {
          enabled: true,
          template_id: TEMPLATE,
        }),
      ),
    ).toBe('DESIGNER_TEMPLATE_INVALID');
  });

  it('a font that is not uploaded is reported as missing_font', async () => {
    const b = build();
    const spec = templateSpec();
    spec.fonts[0].asset_id = '77777777-7777-4777-8777-000000000000';
    b.db.designTemplateVersion.find((v) => v.id === V1)!.spec = spec;
    let err: unknown;
    try {
      await b.templates.publish(STORE, TEMPLATE, V1);
    } catch (e) {
      err = e;
    }
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      errors: [{ path: 'fonts[0]', rule: 'missing_font' }],
    });
  });

  it('ARCHIVED / DRAFT while products are enabled → 409 DESIGNER_TEMPLATE_LINKED', async () => {
    const b = build();
    let err: unknown;
    try {
      await b.templates.update(STORE, TEMPLATE, { status: 'ARCHIVED' });
    } catch (e) {
      err = e;
    }
    expect(designerErrorCode(err)).toBe('DESIGNER_TEMPLATE_LINKED');
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      params: { products: 1, product_ids: [PRODUCT] },
    });
    b.db.productDesigner[0].enabled = false;
    await expect(
      b.templates.update(STORE, TEMPLATE, { status: 'ARCHIVED' }),
    ).resolves.toMatchObject({ status: 'ARCHIVED' });
  });

  it('DELETE product link removes it (idempotent)', async () => {
    const b = build();
    await expect(
      b.templates.deleteProductLink(STORE, PRODUCT),
    ).resolves.toEqual({ deleted: true });
    expect(b.db.productDesigner).toHaveLength(0);
    await expect(
      b.templates.deleteProductLink(STORE, PRODUCT),
    ).resolves.toEqual({ deleted: false });
  });

  it('a new thumbnail deletes the old TEMPLATE_THUMB asset nothing else uses', async () => {
    const b = build();
    const OLD = '77777777-7777-4777-8777-0000000000aa';
    const NEW = '77777777-7777-4777-8777-0000000000bb';
    b.db.designAsset.push(
      asset(OLD, DesignAssetKind.TEMPLATE_THUMB, 500, 700, 'image/webp'),
    );
    b.db.designTemplateVersion.find((v) => v.id === V1)!.thumbnail_url =
      `https://api.test/api/designer/assets/${OLD}.webp`;
    const render = {
      engineEnabled: true,
      renderCanvas: jest.fn(() => Promise.resolve({ data: Buffer.from('w') })),
    };
    Object.assign(b.templates as unknown as { render: unknown }, { render });
    Object.assign(b.assets, {
      storeTemplateAsset: jest.fn(() =>
        Promise.resolve({
          asset: { url: `https://api.test/api/designer/assets/${NEW}.webp` },
        }),
      ),
    });
    await b.templates.renderThumbnail(STORE, TEMPLATE, V1);
    expect(
      (b.assets as unknown as { deleteAsset: jest.Mock }).deleteAsset,
    ).toHaveBeenCalledWith(STORE, OLD);
  });
});

describe('proof keys', () => {
  function fake(counts: { designs: number; orders: number }) {
    return {
      design: {
        count: jest.fn(() => Promise.resolve(counts.designs)),
        findUnique: jest.fn(() => Promise.resolve({ proof_key: 'old' })),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      },
      orderItemDesign: {
        count: jest.fn(() => Promise.resolve(counts.orders)),
      },
    };
  }

  it('a key shared with a live order design is kept', async () => {
    const storage = { delete: jest.fn(() => Promise.resolve(true)) };
    expect(
      await releaseProofKey(
        fake({ designs: 0, orders: 1 }) as never,
        storage,
        'k',
      ),
    ).toBe(false);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(
      await releaseProofKey(
        fake({ designs: 0, orders: 0 }) as never,
        storage,
        'k',
      ),
    ).toBe(true);
  });

  it('replace: records the new key and deletes the old one; a lost race drops the new file', async () => {
    const storage = { delete: jest.fn(() => Promise.resolve(true)) };
    const db = fake({ designs: 0, orders: 0 });
    await replaceDesignProofKey(db as never, storage, {
      designId: 'd1',
      stateVersion: 3,
      newKey: 'new',
      stateSha: 'sha',
    });
    expect(storage.delete).toHaveBeenCalledWith('old');
    storage.delete.mockClear();
    db.design.updateMany.mockResolvedValueOnce({ count: 0 });
    await replaceDesignProofKey(db as never, storage, {
      designId: 'd1',
      stateVersion: 3,
      newKey: 'new2',
      stateSha: 'sha',
    });
    expect(storage.delete).toHaveBeenCalledWith('new2');
  });
});
