import { PrismaService } from '../../prisma/prisma.service';
import { PersonalizationCoreService } from '../../common/personalization/personalization-core.service';
import { CustomerUploadsService } from '../customer-uploads/customer-uploads.service';
import {
  DesignerCartService,
  type DesignerLineMode,
} from './designer-cart.service';
import { designerErrorCode } from './designer-errors';
import { RENDERER_VERSION } from '@multi-stores/core/designer';
import { DesignsService } from './designs.service';
import { designProofSha } from './designs.util';
import type { DesignerRenderService } from './designer-render.service';
import {
  CUSTOMER,
  OTHER_CUSTOMER,
  OTHER_STORE,
  PLAIN_PRODUCT,
  PRODUCT,
  STORE,
  TEMPLATE,
  V1,
  doubles,
  seededDb,
} from './designs.fixtures.mockspec';

// M4.2 WP4 §4.2 rules 1–4, the claim, the order snapshot and the cart view.

function build(opts: { appOn?: boolean } = {}) {
  const db = seededDb();
  const d = doubles(db, opts);
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
  return { db, designs, cart, ...d };
}

/** A complete design (texts + photo) created as a guest. */
async function completeDesign(
  b: ReturnType<typeof build>,
  customerId: string | null = null,
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
        photos: { foto: { ...up.design.state.photos.foto } },
      },
      state_version: up.design.state_version,
    },
    access,
  );
  return { id: created.id, token: created.token, photo: up.asset_id };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return designerErrorCode(e);
  }
  return 'NO_ERROR';
}

describe('DesignerCartService (M4.2 WP4)', () => {
  describe('planLines (quote / order)', () => {
    it('app off, no design: all null after one cached isEnabled and no query (G0)', async () => {
      const b = build({ appOn: false });
      const res = await b.cart.planLines(
        STORE,
        [{ product_id: PRODUCT }, { product_id: PLAIN_PRODUCT }],
        { mode: 'order', customerId: CUSTOMER },
      );
      expect(res).toEqual([null, null]);
      expect(b.storeApps.isEnabled).toHaveBeenCalledTimes(1);
      expect(b.prisma.productDesigner.findMany).not.toHaveBeenCalled();
      expect(b.prisma.design.findUnique).not.toHaveBeenCalled();
    });

    it('rule 1: a design while the app is off → 400 DESIGNER_NOT_ENABLED with the line ref', async () => {
      const b = build({ appOn: false });
      let err: unknown;
      try {
        await b.cart.planLines(
          STORE,
          [
            { product_id: PLAIN_PRODUCT },
            { product_id: PRODUCT, design_id: V1 },
          ],
          { mode: 'quote' },
        );
      } catch (e) {
        err = e;
      }
      expect(designerErrorCode(err)).toBe('DESIGNER_NOT_ENABLED');
      expect((err as { getResponse(): object }).getResponse()).toMatchObject({
        line_index: 1,
      });
    });

    it('rule 2: a linked product without design → DESIGNER_DESIGN_REQUIRED; unlinked products pass', async () => {
      const b = build();
      expect(
        await codeOf(
          b.cart.planLines(STORE, [{ product_id: PRODUCT }], { mode: 'quote' }),
        ),
      ).toBe('DESIGNER_DESIGN_REQUIRED');
      await expect(
        b.cart.planLines(STORE, [{ product_id: PLAIN_PRODUCT }], {
          mode: 'quote',
        }),
      ).resolves.toEqual([null]);
      // A disabled link behaves like no link.
      b.db.productDesigner[0].enabled = false;
      await expect(
        b.cart.planLines(STORE, [{ product_id: PRODUCT }], { mode: 'quote' }),
      ).resolves.toEqual([null]);
    });

    it('rule 3: wrong product, wrong store, unlinked template → mismatch / not found', async () => {
      const b = build();
      const d = await completeDesign(b);
      expect(
        await codeOf(
          b.cart.planLines(
            STORE,
            [{ product_id: PLAIN_PRODUCT, design_id: d.id }],
            { mode: 'quote' },
          ),
        ),
      ).toBe('DESIGNER_TEMPLATE_MISMATCH');
      expect(
        await codeOf(
          b.cart.planLines(
            OTHER_STORE,
            [{ product_id: PRODUCT, design_id: d.id }],
            { mode: 'quote' },
          ),
        ),
      ).toBe('DESIGNER_DESIGN_NOT_FOUND');
      b.db.productDesigner[0].template_id =
        '44444444-4444-4444-8444-000000000000';
      expect(
        await codeOf(
          b.cart.planLines(STORE, [{ product_id: PRODUCT, design_id: d.id }], {
            mode: 'quote',
          }),
        ),
      ).toBe('DESIGNER_TEMPLATE_MISMATCH');
    });

    it('rule 3: owner per mode', async () => {
      const b = build();
      const guestDesign = await completeDesign(b, null);
      const owned = await completeDesign(b, CUSTOMER);
      const plan = (
        mode: DesignerLineMode,
        id: string,
        customerId: string | null,
        token?: string,
        verifiedDesignIds?: string[],
      ) =>
        codeOf(
          b.cart.planLines(
            STORE,
            [
              {
                product_id: PRODUCT,
                design_id: id,
                design_token: token ?? null,
              },
            ],
            { mode, customerId, verifiedDesignIds },
          ),
        );
      // public quote: price only, a sent token must match.
      expect(await plan('quote', guestDesign.id, null)).toBe('NO_ERROR');
      expect(await plan('quote', guestDesign.id, null, 'wrong')).toBe(
        'DESIGNER_DESIGN_FORBIDDEN',
      );
      // order-bound quote (Kustom): verified by the session, or owned.
      expect(await plan('quote', guestDesign.id, null, undefined, [])).toBe(
        'DESIGNER_DESIGN_FORBIDDEN',
      );
      expect(
        await plan('quote', guestDesign.id, null, undefined, [guestDesign.id]),
      ).toBe('NO_ERROR');
      expect(await plan('quote', owned.id, CUSTOMER, undefined, [])).toBe(
        'NO_ERROR',
      );
      // snapshot: only what the session verified (absent = nothing).
      expect(await plan('snapshot', owned.id, OTHER_CUSTOMER)).toBe(
        'DESIGNER_DESIGN_FORBIDDEN',
      );
      expect(
        await plan('snapshot', owned.id, OTHER_CUSTOMER, undefined, [owned.id]),
      ).toBe('NO_ERROR');
      // order from the server cart: the owner (or the token).
      expect(await plan('order', owned.id, CUSTOMER)).toBe('NO_ERROR');
      expect(await plan('order', owned.id, OTHER_CUSTOMER)).toBe(
        'DESIGNER_DESIGN_FORBIDDEN',
      );
      // Once owned, the guest token no longer grants access.
      expect(await plan('order', owned.id, OTHER_CUSTOMER, owned.token)).toBe(
        'DESIGNER_DESIGN_FORBIDDEN',
      );
      expect(await plan('order', guestDesign.id, CUSTOMER)).toBe(
        'DESIGNER_DESIGN_FORBIDDEN',
      );
    });

    it('rule 3: ORDERED is locked in every mode (the storefront duplicates it)', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      b.db.design.find((x) => x.id === d.id)!.status = 'ORDERED';
      const line = [{ product_id: PRODUCT, design_id: d.id }];
      expect(
        await codeOf(
          b.cart.planLines(STORE, line, {
            mode: 'order',
            customerId: CUSTOMER,
          }),
        ),
      ).toBe('DESIGNER_DESIGN_LOCKED');
      expect(
        await codeOf(
          b.cart.planLines(STORE, line, {
            mode: 'snapshot',
            verifiedDesignIds: [d.id],
          }),
        ),
      ).toBe('DESIGNER_DESIGN_LOCKED');
      expect(
        await codeOf(b.cart.planLines(STORE, line, { mode: 'quote' })),
      ).toBe('DESIGNER_DESIGN_LOCKED');
    });

    it('an archived / unpublished template: the link is inactive (plain product, designed lines mismatch)', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      b.db.designTemplate[0].status = 'ARCHIVED';
      expect(
        await b.cart.planLines(STORE, [{ product_id: PRODUCT }], {
          mode: 'order',
          customerId: CUSTOMER,
        }),
      ).toEqual([null]);
      expect(
        await codeOf(
          b.cart.planLines(STORE, [{ product_id: PRODUCT, design_id: d.id }], {
            mode: 'order',
            customerId: CUSTOMER,
          }),
        ),
      ).toBe('DESIGNER_TEMPLATE_MISMATCH');
      expect(
        await b.cart.resolveCartLine(
          { product_id: PRODUCT },
          PRODUCT,
          CUSTOMER,
        ),
      ).toBeNull();
      b.db.designTemplate[0].status = 'PUBLISHED';
      b.db.designTemplate[0].current_version_id = null;
      expect(
        await codeOf(
          b.cart.resolveCartLine(
            { product_id: PRODUCT, design_id: d.id },
            PRODUCT,
            CUSTOMER,
          ),
        ),
      ).toBe('DESIGNER_TEMPLATE_MISMATCH');
    });

    it('verifySessionDesigns (Kustom): guest token / owner / claim / locked; no query without designs', async () => {
      const b = build();
      const guest = await completeDesign(b, null);
      const owned = await completeDesign(b, CUSTOMER);
      const line = (id: string, token?: string) => ({
        product_id: PRODUCT,
        design_id: id,
        design_token: token ?? null,
      });
      b.prisma.design.findUnique.mockClear();
      expect(
        await b.cart.verifySessionDesigns(
          STORE,
          [{ product_id: PRODUCT }],
          null,
        ),
      ).toEqual(new Set());
      expect(b.prisma.design.findUnique).not.toHaveBeenCalled();
      // guest: the token is required
      expect(
        await codeOf(
          b.cart.verifySessionDesigns(STORE, [line(guest.id)], null),
        ),
      ).toBe('DESIGNER_DESIGN_FORBIDDEN');
      expect(
        await b.cart.verifySessionDesigns(
          STORE,
          [line(guest.id, guest.token)],
          null,
        ),
      ).toEqual(new Set([guest.id]));
      // someone else's design without its token
      expect(
        await codeOf(
          b.cart.verifySessionDesigns(STORE, [line(owned.id)], OTHER_CUSTOMER),
        ),
      ).toBe('DESIGNER_DESIGN_FORBIDDEN');
      // the owner, no token needed
      expect(
        await b.cart.verifySessionDesigns(STORE, [line(owned.id)], CUSTOMER),
      ).toEqual(new Set([owned.id]));
      // a session that already verified it keeps it without a token
      expect(
        await b.cart.verifySessionDesigns(STORE, [line(guest.id)], null, [
          guest.id,
        ]),
      ).toEqual(new Set([guest.id]));
      // logged in + token: claimed
      await b.cart.verifySessionDesigns(
        STORE,
        [line(guest.id, guest.token)],
        OTHER_CUSTOMER,
      );
      expect(b.db.design.find((x) => x.id === guest.id)).toMatchObject({
        customer_id: OTHER_CUSTOMER,
        status: 'IN_CART',
      });
      // ordered: locked
      b.db.design.find((x) => x.id === owned.id)!.status = 'ORDERED';
      expect(
        await codeOf(
          b.cart.verifySessionDesigns(STORE, [line(owned.id)], CUSTOMER),
        ),
      ).toBe('DESIGNER_DESIGN_LOCKED');
    });

    it('rule 4: incomplete design (required text / photo) → STATE_INVALID details', async () => {
      const b = build();
      const created = await b.designs.create(
        STORE,
        { product_id: PRODUCT, template_version_id: V1 },
        CUSTOMER,
      );
      let err: unknown;
      try {
        await b.cart.planLines(
          STORE,
          [{ product_id: PRODUCT, design_id: created.id }],
          {
            mode: 'order',
            customerId: CUSTOMER,
            refs: [{ line_id: 'row-1' }],
          },
        );
      } catch (e) {
        err = e;
      }
      expect(designerErrorCode(err)).toBe('DESIGNER_STATE_INVALID');
      expect((err as { getResponse(): object }).getResponse()).toMatchObject({
        line_id: 'row-1',
        details: [
          { element_id: 'foto', rule: 'photo_required' },
          { element_id: 'namn', rule: 'required' },
        ],
      });
    });

    it('a purged photo makes the design invalid (asset rule)', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      b.db.designAsset.find((a) => a.id === d.photo)!.purged_at = new Date();
      expect(
        await codeOf(
          b.cart.planLines(STORE, [{ product_id: PRODUCT, design_id: d.id }], {
            mode: 'order',
            customerId: CUSTOMER,
          }),
        ),
      ).toBe('DESIGNER_STATE_INVALID');
    });

    it('designer delta is 0 (D9)', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      const [line] = await b.cart.planLines(
        STORE,
        [{ product_id: PRODUCT, design_id: d.id }],
        {
          mode: 'order',
          customerId: CUSTOMER,
        },
      );
      expect(line?.priceDelta).toBe(0);
      expect(b.cart.lineDelta()).toEqual({ priceDelta: 0, addons: [] });
    });
  });

  describe('resolveCartLine (server cart add / guest migration)', () => {
    it('ordinary product: one PK lookup, null', async () => {
      const b = build();
      await expect(
        b.cart.resolveCartLine(
          { product_id: PLAIN_PRODUCT },
          PLAIN_PRODUCT,
          CUSTOMER,
        ),
      ).resolves.toBeNull();
      expect(b.prisma.productDesigner.findUnique).toHaveBeenCalledTimes(1);
      expect(b.storeApps.isEnabled).not.toHaveBeenCalled();
    });

    it('linked product without design: required while the app is on, ordinary while it is off', async () => {
      const on = build();
      expect(
        await codeOf(
          on.cart.resolveCartLine({ product_id: PRODUCT }, PRODUCT, CUSTOMER),
        ),
      ).toBe('DESIGNER_DESIGN_REQUIRED');
      const off = build({ appOn: false });
      await expect(
        off.cart.resolveCartLine({ product_id: PRODUCT }, PRODUCT, CUSTOMER),
      ).resolves.toBeNull();
    });

    it('guest design: token required, then claimed (customer + IN_CART)', async () => {
      const b = build();
      const d = await completeDesign(b, null);
      expect(
        await codeOf(
          b.cart.resolveCartLine(
            { product_id: PRODUCT, design_id: d.id },
            PRODUCT,
            CUSTOMER,
          ),
        ),
      ).toBe('DESIGNER_DESIGN_FORBIDDEN');
      const line = await b.cart.resolveCartLine(
        { product_id: PRODUCT, design_id: d.id, design_token: d.token },
        PRODUCT,
        CUSTOMER,
      );
      expect(line?.design.customer_id).toBe(CUSTOMER);
      const row = b.db.design.find((x) => x.id === d.id)!;
      expect(row.customer_id).toBe(CUSTOMER);
      expect(row.status).toBe('IN_CART');
      // Now the owner adds again without a token.
      await expect(
        b.cart.resolveCartLine(
          { product_id: PRODUCT, design_id: d.id },
          PRODUCT,
          CUSTOMER,
        ),
      ).resolves.not.toBeNull();
    });

    it('a design while the app is off → NOT_ENABLED', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      b.storeApps.isEnabled.mockResolvedValue(false);
      expect(
        await codeOf(
          b.cart.resolveCartLine(
            { product_id: PRODUCT, design_id: d.id },
            PRODUCT,
            CUSTOMER,
          ),
        ),
      ).toBe('DESIGNER_NOT_ENABLED');
    });
  });

  describe('snapshot / markOrdered / read views', () => {
    it('freezes spec, state, assets (sha256, dpi), text values in the order locale and DESIGN rows', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      b.db.design.find((x) => x.id === d.id)!.proof_key =
        'designer/x/proof.webp';
      const row = b.db.design.find((x) => x.id === d.id)!;
      row.proof_state_sha = designProofSha(row.state, V1);
      const [line] = await b.cart.planLines(
        STORE,
        [{ product_id: PRODUCT, design_id: d.id }],
        {
          mode: 'order',
          customerId: CUSTOMER,
        },
      );
      const snap = await b.cart.snapshot(line!, {
        orderId: 'order-1',
        storeId: STORE,
        locale: 'en',
        primaryLocale: 'sv',
      });
      expect(snap.create).toMatchObject({
        order_id: 'order-1',
        store_id: STORE,
        design_id: d.id,
        template_id: TEMPLATE,
        template_version_id: V1,
        renderer_version: RENDERER_VERSION,
        proof_key: 'designer/x/proof.webp',
        print_status: 'PENDING',
        print_requested_at: null,
        price_breakdown: { designer_delta: 0, addons: [] },
      });
      expect(snap.create.text_values).toEqual([
        { element_id: 'namn', label: 'Name', value: 'Anna' },
        { element_id: 'klass', label: 'Klass', value: 'Klass 9A' },
      ]);
      const assets = snap.create.assets as Record<string, unknown>[];
      expect(assets.map((a) => a.role)).toEqual([
        'photo',
        'bg_web',
        'bg_print',
        'font',
      ]);
      expect(assets[0]).toMatchObject({
        element_id: 'foto',
        width: 2400,
        height: 3600,
        low_res: false,
      });
      expect(assets[1]).toMatchObject({
        sha256: expect.stringMatching(/^sha-/) as unknown,
      });
      expect(snap.designTexts).toEqual([
        {
          element_id: 'namn',
          label: { sv: 'Namn', en: 'Name' },
          value: 'Anna',
        },
        { element_id: 'klass', label: { sv: 'Klass' }, value: 'Klass 9A' },
      ]);
    });

    it('no proof for the current state → proof_key null (the worker renders it)', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      b.db.design.find((x) => x.id === d.id)!.proof_key = 'designer/x/old.webp';
      const [line] = await b.cart.planLines(
        STORE,
        [{ product_id: PRODUCT, design_id: d.id }],
        {
          mode: 'order',
          customerId: CUSTOMER,
        },
      );
      const snap = await b.cart.snapshot(line!, {
        orderId: 'o',
        storeId: STORE,
      });
      expect(snap.create.proof_key).toBeNull();
    });

    it('the DESIGN rows of buildOrderValues (C19)', () => {
      const core = new PersonalizationCoreService(
        {} as PrismaService,
        {} as CustomerUploadsService,
      );
      const rows = core.buildOrderValues(
        { line_index: 0 },
        { productId: PRODUCT, fields: [], prefilled: {} },
        {},
        {
          designTexts: [
            { element_id: 'namn', label: { sv: 'Namn' }, value: 'Anna' },
            { element_id: 'klass', label: {}, value: 'Klass 9A' },
          ],
        },
      );
      expect(rows).toEqual([
        {
          custom_field_id: null,
          value: 'Anna',
          field_name: 'namn',
          field_type: 'TEXT',
          field_label: { sv: 'Namn' },
          sort_order: 10000,
          source: 'DESIGN',
        },
        {
          custom_field_id: null,
          value: 'Klass 9A',
          field_name: 'klass',
          field_type: 'TEXT',
          sort_order: 10001,
          source: 'DESIGN',
        },
      ]);
      // Without designTexts nothing changes.
      expect(
        core.buildOrderValues(
          { line_index: 0 },
          { productId: PRODUCT, fields: [], prefilled: {} },
          {},
        ),
      ).toEqual([]);
    });

    it('markOrdered freezes the designs at the validated state_version', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      const row = b.db.design.find((x) => x.id === d.id)!;
      const v = row.state_version as number;
      await b.cart.markOrdered(b.prisma as never, [
        { id: d.id, state_version: v },
        { id: d.id, state_version: v },
        { id: 'junk', state_version: 1 },
      ]);
      expect(row.status).toBe('ORDERED');
      // A second order of the same design (concurrent checkout) is refused.
      expect(
        await codeOf(
          b.cart.markOrdered(b.prisma as never, [
            { id: d.id, state_version: v },
          ]),
        ),
      ).toBe('DESIGNER_DESIGN_LOCKED');
    });

    it('markOrdered: a design edited after validation → 409 STALE (order rolled back)', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      const row = b.db.design.find((x) => x.id === d.id)!;
      const v = row.state_version as number;
      row.state_version = v + 1; // PATCH between planLines and the insert
      expect(
        await codeOf(
          b.cart.markOrdered(b.prisma as never, [
            { id: d.id, state_version: v },
          ]),
        ),
      ).toBe('DESIGNER_DESIGN_STALE');
      expect(row.status).not.toBe('ORDERED');
    });

    it('cart view: text values in the request locale, proof only for the current state', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      let views = await b.cart.cartDesigns([d.id], 'sv');
      expect(views.get(d.id)).toEqual({
        id: d.id,
        text_values: [
          { element_id: 'namn', label: 'Namn', value: 'Anna' },
          { element_id: 'klass', label: 'Klass', value: 'Klass 9A' },
        ],
        editable: true,
        proof_url: null,
        product_slug: null,
      });
      Object.assign(b.db.design.find((x) => x.id === d.id)!, {
        proof_key: 'k',
        proof_state_sha: 's',
      });
      views = await b.cart.cartDesigns([d.id], 'sv');
      expect(views.get(d.id)?.proof_url).toBe(
        `https://api.test/api/designer/files/proof-${d.id}`,
      );
      expect(
        b.cart.orderItemProofUrl({
          id: 'oid',
          store_id: STORE,
          proof_key: 'k',
          files_purged_at: null,
        }),
      ).toBe('https://api.test/api/designer/files/oid_proof-oid');
      expect(
        b.cart.orderItemProofUrl({
          id: 'oid',
          store_id: STORE,
          proof_key: 'k',
          files_purged_at: new Date(),
        }),
      ).toBeNull();
    });
  });

  describe('proofs + order designs (WP5 wiring)', () => {
    it('a stale proof sha is not reused by the snapshot', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      Object.assign(b.db.design.find((x) => x.id === d.id)!, {
        proof_key: 'k',
        proof_state_sha: 'other',
      });
      const [line] = await b.cart.planLines(
        STORE,
        [{ product_id: PRODUCT, design_id: d.id }],
        {
          mode: 'order',
          customerId: CUSTOMER,
        },
      );
      expect(
        (await b.cart.snapshot(line!, { orderId: 'o', storeId: STORE })).create
          .proof_key,
      ).toBeNull();
    });

    it('ensureProof: fire-and-forget, a 503 is swallowed; without the render service a no-op', async () => {
      const b = build();
      const render = {
        renderDesignProof: jest.fn(() => Promise.reject(new Error('503'))),
      };
      const cart = new DesignerCartService(
        b.prisma as unknown as PrismaService,
        b.storeApps,
        b.designs,
        b.assets,
        b.urls,
        render as unknown as DesignerRenderService,
      );
      const id = '99999999-9999-4999-8999-999999999999';
      expect(() => cart.ensureProof(id)).not.toThrow();
      await Promise.resolve();
      expect(render.renderDesignProof).toHaveBeenCalledWith(id);
      expect(() => b.cart.ensureProof(id)).not.toThrow();
    });

    it('orderDesigns: own store only; proof, photos, print status, purge dates', async () => {
      const b = build();
      const d = await completeDesign(b, CUSTOMER);
      const created = new Date('2026-10-01T00:00:00Z');
      const orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      Object.assign(b.prisma, {
        order: {
          findFirst: jest.fn(({ where }: { where: { store_id: string } }) =>
            Promise.resolve(
              where.store_id === STORE
                ? {
                    id: orderId,
                    order_number: 'ORD-1',
                    created_at: created,
                    status: 'CONFIRMED',
                  }
                : null,
            ),
          ),
        },
      });
      b.db.orderItemDesign.push({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        order_item_id: 'item-1',
        order_id: orderId,
        store_id: STORE,
        design_id: d.id,
        template_id: TEMPLATE,
        template_version_id: V1,
        renderer_version: '1.0.0',
        text_values: [{ element_id: 'namn', label: 'Namn', value: 'Anna' }],
        assets: [
          {
            asset_id: d.photo,
            role: 'photo',
            element_id: 'foto',
            low_res: true,
          },
          { asset_id: 'bg', role: 'bg_web' },
        ],
        proof_key: 'k',
        print_status: 'READY',
        print_attempts: 1,
        print_error: null,
        print_requested_at: created,
        print_rendered_at: created,
        print_files: [
          {
            surface: 'front',
            format: 'png',
            key: 'secret-key',
            width_px: 3000,
            height_px: 4200,
            dpi: 152.4,
            bytes: 9,
          },
        ],
        shipped_at: new Date('2026-10-05T00:00:00Z'),
        terminal_at: null,
        originals_purged_at: null,
        files_purged_at: null,
        created_at: created,
        order_item: {
          id: 'item-1',
          product_id: PRODUCT,
          variant_id: null,
          quantity: 1,
        },
      });
      const res = await b.cart.orderDesigns(STORE, orderId);
      expect(res.order_number).toBe('ORD-1');
      const [item] = res.items;
      expect(item).toMatchObject({
        order_item_id: 'item-1',
        proof_url: expect.stringContaining('oid_proof-') as unknown,
        low_res: true,
        print: {
          status: 'READY',
          download_path: `/api/designer/my/orders/${orderId}/items/item-1/print`,
        },
        originals_purge_at: new Date('2026-11-30T00:00:00Z'),
        files_purge_at: new Date('2026-11-04T00:00:00Z'),
      });
      expect(item.assets[0]).toMatchObject({
        preview_url: expect.stringContaining('preview-') as unknown,
        original_available: true,
      });
      expect(JSON.stringify(res)).not.toContain('secret-key');
      // Retention R3 rule: without a READY print (order not terminal) the
      // originals wait up to the 7-day print grace.
      const pendingRow = b.db.orderItemDesign[b.db.orderItemDesign.length - 1];
      Object.assign(pendingRow, { print_status: 'PENDING', print_files: null });
      const again = await b.cart.orderDesigns(STORE, orderId);
      expect(again.items[0].originals_purge_at).toEqual(
        new Date('2026-12-07T00:00:00Z'),
      );
      await expect(
        b.cart.orderDesigns(OTHER_STORE, orderId),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'DESIGNER_DESIGN_NOT_FOUND',
        }) as unknown,
      });
    });
  });
});

// M5.5: add-ons priced from the link's current config, frozen with the order.
describe('DesignerCartService add-ons (M5.5)', () => {
  const CONFIG = {
    v: 2,
    items: [
      {
        key: 'double',
        type: 'toggle',
        label: { sv: 'Dubbelsidig' },
        price: 149,
        enabled: true,
        sort: 0,
      },
      {
        key: 'rain',
        type: 'toggle',
        label: { sv: 'Regnskydd' },
        price: 29,
        enabled: false,
        sort: 1,
      },
      {
        key: 'poster',
        type: 'quantity',
        label: { sv: 'Poster' },
        price: 179,
        max_qty: 10,
        enabled: true,
        sort: 2,
      },
    ],
  };

  it('planLines prices the selection; snapshot freezes it and adds DESIGN rows', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    b.db.productDesigner[0].addons = CONFIG;
    b.db.design.find((x) => x.id === d.id)!.addons = {
      double: 1,
      rain: 1,
      poster: 2,
    };
    const [line] = await b.cart.planLines(
      STORE,
      [{ product_id: PRODUCT, design_id: d.id }],
      { mode: 'order', customerId: CUSTOMER },
    );
    // The disabled rain cover is ignored.
    expect(line!.priceDelta).toBe(149 + 2 * 179);
    expect(line!.addons.map((a) => a.key)).toEqual(['double', 'poster']);
    const snap = await b.cart.snapshot(line!, {
      orderId: 'o',
      storeId: STORE,
      locale: 'sv',
      addons: line!.addons,
      addonsTotal: line!.priceDelta,
      currency: 'SEK',
    });
    expect(snap.create.price_breakdown).toMatchObject({
      designer_delta: 507,
      currency: 'SEK',
      addons: [
        expect.objectContaining({ key: 'double', qty: 1, amount: 149 }),
        expect.objectContaining({ key: 'poster', qty: 2, amount: 358 }),
      ],
    });
    const addonRows = snap.designTexts.filter((t) =>
      t.element_id.startsWith('addon:'),
    );
    expect(addonRows.map((r) => [r.element_id, r.label.sv])).toEqual([
      ['addon:double', 'Dubbelsidig'],
      ['addon:poster', 'Poster'],
    ]);
    expect(addonRows[0].value).toMatch(/^\+149\s?kr$/);
    expect(addonRows[1].value).toMatch(/^× 2 \(\+358\s?kr\)$/);
  });

  it('no config (legacy NPP data) or no selection → delta 0, unchanged breakdown', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    b.db.productDesigner[0].addons = {
      double: { enabled: false, source_enabled: true, price: 149 },
    };
    b.db.design.find((x) => x.id === d.id)!.addons = { double: 1 };
    const [line] = await b.cart.planLines(
      STORE,
      [{ product_id: PRODUCT, design_id: d.id }],
      { mode: 'order', customerId: CUSTOMER },
    );
    expect(line!.priceDelta).toBe(0);
    const snap = await b.cart.snapshot(line!, { orderId: 'o', storeId: STORE });
    expect(snap.create.price_breakdown).toEqual({
      designer_delta: 0,
      addons: [],
    });
    expect(
      snap.designTexts.some((t) => t.element_id.startsWith('addon:')),
    ).toBe(false);
  });

  it('cartDesigns lists the priced add-ons (base currency, request locale)', async () => {
    const b = build();
    const d = await completeDesign(b, CUSTOMER);
    b.db.productDesigner[0].addons = CONFIG;
    b.db.design.find((x) => x.id === d.id)!.addons = { poster: 3 };
    const views = await b.cart.cartDesigns([d.id], 'sv');
    expect(views.get(d.id)?.addons).toEqual([
      {
        key: 'poster',
        type: 'quantity',
        label: 'Poster',
        qty: 3,
        unit_price: 179,
        amount: 537,
      },
    ]);
  });
});
