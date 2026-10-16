import { PrismaService } from '../../prisma/prisma.service';
import { designerErrorCode } from './designer-errors';
import {
  DesignsService,
  designTokenMatches,
  hashDesignToken,
} from './designs.service';
import {
  CUSTOMER,
  OTHER_CUSTOMER,
  OTHER_STORE,
  PLAIN_PRODUCT,
  PRODUCT,
  STORE,
  TEMPLATE,
  V1,
  V2,
  doubles,
  seededDb,
} from './designs.fixtures.mockspec';

// M4.2 WP4 §4.1: the public design draft API.

function build(opts: { settings?: Record<string, unknown> } = {}) {
  const db = seededDb();
  const d = doubles(db, opts);
  const service = new DesignsService(
    d.prisma as unknown as PrismaService,
    d.storeApps,
    d.assets,
    d.urls,
  );
  return { db, service, ...d };
}

const guest = { customerId: null, token: null };

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return designerErrorCode(e);
  }
  return 'NO_ERROR';
}

describe('DesignsService (M4.2 WP4)', () => {
  it('create: token returned once, only its sha256 stored; customer set from the JWT', async () => {
    const { service, db } = build();
    const res = await service.create(
      STORE,
      {
        product_id: PRODUCT,
        template_version_id: V1,
        state: { v: 1, texts: { namn: '  Anna ' }, photos: {} },
      },
      CUSTOMER,
    );
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db.design[0];
    expect(row.access_token_hash).toBe(hashDesignToken(res.token));
    expect(JSON.stringify(row)).not.toContain(res.token);
    expect(row.customer_id).toBe(CUSTOMER);
    expect(row.status).toBe('DRAFT');
    expect(res.state.texts.namn).toBe('  Anna ');
    expect(res.state_version).toBe(1);
  });

  it('create: unlinked product / newer version / other store are refused', async () => {
    const { service, db } = build();
    expect(
      await codeOf(
        service.create(
          STORE,
          { product_id: PLAIN_PRODUCT, template_version_id: V1 },
          null,
        ),
      ),
    ).toBe('DESIGNER_TEMPLATE_MISMATCH');
    // V2 exists but is newer than the published current version (V1).
    expect(
      await codeOf(
        service.create(
          STORE,
          { product_id: PRODUCT, template_version_id: V2 },
          null,
        ),
      ),
    ).toBe('DESIGNER_TEMPLATE_MISMATCH');
    expect(
      await codeOf(
        service.create(
          OTHER_STORE,
          { product_id: PRODUCT, template_version_id: V1 },
          null,
        ),
      ),
    ).toBe('DESIGNER_DESIGN_NOT_FOUND');
    // An archived template takes no new designs.
    db.designTemplate[0].status = 'ARCHIVED';
    expect(
      await codeOf(
        service.create(
          STORE,
          { product_id: PRODUCT, template_version_id: V1 },
          null,
        ),
      ),
    ).toBe('DESIGNER_TEMPLATE_MISMATCH');
  });

  it('create: invalid texts (max_length) and photos not uploaded to the design are 400 STATE_INVALID', async () => {
    const { service } = build();
    let err: unknown;
    try {
      await service.create(
        STORE,
        {
          product_id: PRODUCT,
          template_version_id: V1,
          state: {
            v: 1,
            texts: { namn: 'x'.repeat(11) },
            photos: {
              foto: {
                asset_id: '88888888-8888-4888-8888-000000000099',
                width: 10,
                height: 10,
                adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
              },
            },
          },
        },
        null,
      );
    } catch (e) {
      err = e;
    }
    expect(designerErrorCode(err)).toBe('DESIGNER_STATE_INVALID');
    expect(
      (err as { getResponse(): { details: unknown } }).getResponse().details,
    ).toEqual([
      { element_id: 'namn', rule: 'max_length' },
      { element_id: 'foto', rule: 'asset' },
    ]);
  });

  it('access: token or owning customer; everything else is 404 (no enumeration)', async () => {
    const { service } = build();
    const { id, token } = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      CUSTOMER,
    );
    // An owned design answers to its customer only (designer-access.ts);
    // the guest token works while the design has no owner.
    expect(
      await codeOf(service.get(STORE, id, { customerId: null, token })),
    ).toBe('DESIGNER_DESIGN_NOT_FOUND');
    await expect(
      service.get(STORE, id, { customerId: CUSTOMER, token: null }),
    ).resolves.toMatchObject({ id });
    const guestMade = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      null,
    );
    await expect(
      service.get(STORE, guestMade.id, {
        customerId: null,
        token: guestMade.token,
      }),
    ).resolves.toMatchObject({ id: guestMade.id });
    expect(await codeOf(service.get(STORE, id, guest))).toBe(
      'DESIGNER_DESIGN_NOT_FOUND',
    );
    expect(
      await codeOf(
        service.get(STORE, id, { customerId: OTHER_CUSTOMER, token: 'nope' }),
      ),
    ).toBe('DESIGNER_DESIGN_NOT_FOUND');
    expect(
      await codeOf(service.get(OTHER_STORE, id, { customerId: null, token })),
    ).toBe('DESIGNER_DESIGN_NOT_FOUND');
    expect(
      await codeOf(
        service.get(STORE, 'not-a-uuid', { customerId: null, token }),
      ),
    ).toBe('DESIGNER_DESIGN_NOT_FOUND');
  });

  it('update: optimistic version, stale → 409, clears the proof sha; ORDERED → 409 LOCKED', async () => {
    const { service, db } = build();
    const { id, token } = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      null,
    );
    const access = { customerId: null, token };
    db.design[0].proof_state_sha = 'abc';
    const next = await service.update(
      STORE,
      id,
      { state: { v: 1, texts: { namn: 'Bo' }, photos: {} }, state_version: 1 },
      access,
    );
    expect(next.state_version).toBe(2);
    expect(db.design[0].state_version).toBe(2);
    expect(db.design[0].proof_state_sha).toBeNull();
    expect(
      await codeOf(
        service.update(
          STORE,
          id,
          { state: { v: 1, texts: {}, photos: {} }, state_version: 1 },
          access,
        ),
      ),
    ).toBe('DESIGNER_DESIGN_STALE');
    db.design[0].status = 'ORDERED';
    expect(
      await codeOf(
        service.update(
          STORE,
          id,
          { state: { v: 1, texts: {}, photos: {} }, state_version: 2 },
          access,
        ),
      ),
    ).toBe('DESIGNER_DESIGN_LOCKED');
    expect(await codeOf(service.get(STORE, id, access))).toBe(
      'DESIGNER_DESIGN_LOCKED',
    );
  });

  it('photo upload: size limit from the settings, slot default adj, stored size, replaces + deletes the old photo', async () => {
    const { service, db, assets } = build({ settings: { max_upload_mb: 5 } });
    const { id, token } = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      null,
    );
    const access = { customerId: null, token };
    const first = await service.uploadPhoto(
      STORE,
      id,
      'foto',
      Buffer.from('a'),
      access,
    );
    expect(assets.storePhoto).toHaveBeenCalledWith(STORE, expect.any(Buffer), {
      design_id: id,
      max_bytes: 5 * 1024 * 1024,
    });
    expect(first.width).toBe(2400);
    expect(first.preview_url).toContain('preview-');
    expect(first.effective_dpi_default).toBeGreaterThan(0);
    expect(first.design.state.photos.foto).toEqual({
      asset_id: first.asset_id,
      width: 2400,
      height: 3600,
      adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
    });
    const second = await service.uploadPhoto(
      STORE,
      id,
      'foto',
      Buffer.from('b'),
      access,
    );
    expect(second.design.state.photos.foto.asset_id).toBe(second.asset_id);
    expect(db.designAsset.find((a) => a.id === first.asset_id)).toBeUndefined();
    expect(assets.purgeAssetFiles).toHaveBeenCalledTimes(1);
    // The state keeps the photo after a PATCH that sends a forged size.
    const patched = await service.update(
      STORE,
      id,
      {
        state: {
          v: 1,
          texts: {},
          photos: {
            foto: {
              asset_id: second.asset_id,
              width: 1,
              height: 1,
              adj: { zoom: 2, rot: 10, panX: 0.2, panY: 0.8 },
            },
          },
        },
        state_version: second.design.state_version,
      },
      access,
    );
    expect(patched.state.photos.foto.width).toBe(2400);
    expect(patched.state.photos.foto.adj.zoom).toBe(2);
  });

  it('photo upload: unknown slot is 400; a photo of another design cannot be referenced', async () => {
    const { service } = build();
    const a = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      null,
    );
    const b = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      null,
    );
    expect(
      await codeOf(
        service.uploadPhoto(STORE, a.id, 'namn', Buffer.from('x'), {
          customerId: null,
          token: a.token,
        }),
      ),
    ).toBe('DESIGNER_STATE_INVALID');
    const up = await service.uploadPhoto(
      STORE,
      a.id,
      'foto',
      Buffer.from('x'),
      {
        customerId: null,
        token: a.token,
      },
    );
    expect(
      await codeOf(
        service.update(
          STORE,
          b.id,
          {
            state: {
              v: 1,
              texts: {},
              photos: {
                foto: {
                  asset_id: up.asset_id,
                  width: 1,
                  height: 1,
                  adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
                },
              },
            },
            state_version: 1,
          },
          { customerId: null, token: b.token },
        ),
      ),
    ).toBe('DESIGNER_STATE_INVALID');
  });

  it('delete photo: removed from the state and deleted; unknown id → 404', async () => {
    const { service, db } = build();
    const { id, token } = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      null,
    );
    const access = { customerId: null, token };
    const up = await service.uploadPhoto(
      STORE,
      id,
      'foto',
      Buffer.from('x'),
      access,
    );
    const view = await service.deletePhoto(STORE, id, up.asset_id, access);
    expect(view.state.photos).toEqual({});
    expect(db.designAsset.find((a) => a.id === up.asset_id)).toBeUndefined();
    expect(
      await codeOf(service.deletePhoto(STORE, id, up.asset_id, access)),
    ).toBe('DESIGNER_ASSET_NOT_FOUND');
  });

  it('token comparison is exact and length-safe', () => {
    const h = hashDesignToken('abc');
    expect(designTokenMatches(h, 'abc')).toBe(true);
    expect(designTokenMatches(h, 'abd')).toBe(false);
    expect(designTokenMatches(h, '')).toBe(false);
    expect(designTokenMatches(null, 'abc')).toBe(false);
    expect(designTokenMatches(h, 'x'.repeat(300))).toBe(false);
    expect(TEMPLATE).toBeTruthy();
  });

  it('proof: renders through WP5 for an accessible design; 503 without the engine; LOCKED once ordered', async () => {
    const b = build();
    const render = {
      renderDesignProof: jest.fn(() =>
        Promise.resolve({
          proof_key: 'k',
          proof_url: '/api/designer/files/p',
          reused: false,
        }),
      ),
    };
    const service = new DesignsService(
      b.prisma as unknown as PrismaService,
      b.storeApps,
      b.assets,
      b.urls,
      render as never,
    );
    const { id, token } = await service.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1 },
      null,
    );
    const access = { customerId: null, token };
    await expect(service.proof(STORE, id, access)).resolves.toEqual({
      proof_url: '/api/designer/files/p',
      reused: false,
    });
    expect(render.renderDesignProof).toHaveBeenCalledWith(id);
    expect(await codeOf(service.proof(STORE, id, guest))).toBe(
      'DESIGNER_DESIGN_NOT_FOUND',
    );
    expect(await codeOf(b.service.proof(STORE, id, access))).toBe(
      'DESIGNER_RENDER_UNAVAILABLE',
    );
    b.db.design[0].status = 'ORDERED';
    expect(await codeOf(service.proof(STORE, id, access))).toBe(
      'DESIGNER_DESIGN_LOCKED',
    );
  });
});
