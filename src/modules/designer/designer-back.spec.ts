import type {
  ImageSlotElement,
  TextElement,
} from '@multi-stores/core/designer';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  backEnabledBy,
  legacyAddonPresets,
  validateAddonsConfig,
} from './designer-addons';
import {
  allowedBackTemplateIds,
  backLabels,
  readBack,
  sideOf,
} from './designer-back';
import { DesignerCartService } from './designer-cart.service';
import { designerErrorCode } from './designer-errors';
import { DesignsService } from './designs.service';
import {
  CUSTOMER,
  OTHER_STORE,
  PRODUCT,
  STORE,
  TEMPLATE,
  V1,
  doubles,
  seededDb,
  templateSpec,
} from './designs.fixtures.mockspec';

// M5.6 double-sided designs: the back-side gate, template rules, clearing
// on deselect, the back photo route and the order-time freeze.

const BACK_TEMPLATE = '44444444-4444-4444-8444-444444444499';
const BACK_V1 = '55555555-5555-4555-8555-555555555599';
const OTHER_TEMPLATE = '44444444-4444-4444-8444-444444444488';
const OTHER_V1 = '55555555-5555-4555-8555-555555555588';
const UNPUBLISHED = '44444444-4444-4444-8444-444444444477';
const UNPUBLISHED_V1 = '55555555-5555-4555-8555-555555555577';

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
      enables_back: true,
    },
    {
      key: 'poster',
      type: 'quantity',
      label: { sv: 'Poster' },
      price: 179,
      max_qty: 10,
      enabled: true,
      sort: 1,
    },
  ],
};

/** A second back template: one required photo slot "bild" and a text "text". */
function backSpec() {
  const spec = templateSpec();
  const slot = spec.surfaces[0].elements[0] as ImageSlotElement;
  const text = spec.surfaces[0].elements[1] as TextElement;
  spec.surfaces[0].elements = [
    { ...slot, id: 'bild', required: true },
    { ...text, id: 'text', required: true },
  ];
  return spec;
}

function build() {
  const db = seededDb();
  db.productDesigner[0].addons = CONFIG;
  db.productDesigner[0].back_template_ids = [BACK_TEMPLATE, UNPUBLISHED];
  db.designTemplate.push(
    {
      id: BACK_TEMPLATE,
      store_id: STORE,
      name: 'Baksida',
      status: 'PUBLISHED',
      current_version_id: BACK_V1,
      source: 'native',
      external_ref: null,
    },
    {
      id: OTHER_TEMPLATE,
      store_id: OTHER_STORE,
      name: 'Other store',
      status: 'PUBLISHED',
      current_version_id: OTHER_V1,
      source: 'native',
      external_ref: null,
    },
    {
      id: UNPUBLISHED,
      store_id: STORE,
      name: 'Draft',
      status: 'DRAFT',
      current_version_id: UNPUBLISHED_V1,
      source: 'native',
      external_ref: null,
    },
  );
  db.designTemplateVersion.push(
    { id: BACK_V1, template_id: BACK_TEMPLATE, version: 1, spec: backSpec() },
    { id: OTHER_V1, template_id: OTHER_TEMPLATE, version: 1, spec: backSpec() },
    {
      id: UNPUBLISHED_V1,
      template_id: UNPUBLISHED,
      version: 1,
      spec: backSpec(),
    },
  );
  const d = doubles(db);
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

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return designerErrorCode(e);
  }
  return 'NO_ERROR';
}

/** A complete front (photo + name) with the double add-on chosen. */
async function completeFront(b: ReturnType<typeof build>) {
  const created = await b.designs.create(
    STORE,
    { product_id: PRODUCT, template_version_id: V1, addons: { double: 1 } },
    CUSTOMER,
  );
  const access = { customerId: CUSTOMER, token: created.token };
  const up = await b.designs.uploadPhoto(
    STORE,
    created.id,
    'foto',
    Buffer.from('x'),
    access,
  );
  const view = await b.designs.update(
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
  return { id: created.id, access, view };
}

describe('designer-back helpers', () => {
  it('readBack: same / other / null / malformed', () => {
    expect(readBack(null)).toBeNull();
    expect(readBack({ mode: 'same' })).toEqual({ mode: 'same' });
    expect(readBack({ mode: 'flip' })).toBe(false);
    expect(readBack({ mode: 'other', template_id: 'x' })).toBe(false);
    expect(
      readBack({
        mode: 'other',
        template_id: BACK_TEMPLATE,
        state: { texts: { a: 'b' } },
      }),
    ).toEqual({
      mode: 'other',
      template_id: BACK_TEMPLATE,
      template_version_id: '',
      state: { v: 1, texts: { a: 'b' }, photos: {} },
    });
  });

  it('allowedBackTemplateIds: own template first, no duplicates; sideOf; backLabels', () => {
    expect(
      allowedBackTemplateIds({
        template_id: TEMPLATE,
        back_template_ids: [BACK_TEMPLATE, TEMPLATE, 'junk', BACK_TEMPLATE],
      }),
    ).toEqual([TEMPLATE, BACK_TEMPLATE]);
    expect(sideOf({ side: 'back' })).toBe('back');
    expect(sideOf({})).toBe('front');
    expect(sideOf(null)).toBe('front');
    const labels = backLabels({ sv: 'Namn', en: 'Name' });
    expect(labels.sv).toBe('Baksida: Namn');
    expect(labels.en).toBe('Back: Name');
    expect(labels.de).toBe('Rückseite: Name');
  });

  it('add-ons: enables_back validates, the double preset carries it, backEnabledBy gates', () => {
    const ok = validateAddonsConfig(CONFIG);
    expect(ok.ok && ok.value.items[0].enables_back).toBe(true);
    expect(ok.ok && ok.value.items[1]).not.toHaveProperty('enables_back');
    const bad = validateAddonsConfig({
      ...CONFIG,
      items: [{ ...CONFIG.items[0], enables_back: 'yes' }],
    });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors[0]).toEqual({
      path: 'items.0.enables_back',
      rule: 'enables_back',
    });
    expect(
      legacyAddonPresets({ double: { enabled: false, price: 149 } })[0],
    ).toMatchObject({ key: 'double', enables_back: true });
    expect(backEnabledBy(CONFIG, { double: 1 })).toBe(true);
    expect(backEnabledBy(CONFIG, { poster: 2 })).toBe(false);
    expect(backEnabledBy(CONFIG, null)).toBe(false);
    // The `double` key enables the back by default; an explicit false wins.
    const legacyDouble = {
      ...CONFIG,
      items: [{ ...CONFIG.items[0], enables_back: undefined }],
    };
    expect(backEnabledBy(legacyDouble, { double: 1 })).toBe(true);
    const off = {
      ...CONFIG,
      items: [{ ...CONFIG.items[0], enables_back: false }],
    };
    expect(backEnabledBy(off, { double: 1 })).toBe(false);
  });
});

describe('DesignsService back side (M5.6)', () => {
  it('a back is stored only with the enabling add-on; G0: no back keys otherwise', async () => {
    const b = build();
    const without = await b.designs.create(
      STORE,
      { product_id: PRODUCT, template_version_id: V1, back: { mode: 'same' } },
      null,
    );
    expect(without).not.toHaveProperty('back');
    expect(without).not.toHaveProperty('proof_back_url');
    const withAddon = await b.designs.create(
      STORE,
      {
        product_id: PRODUCT,
        template_version_id: V1,
        addons: { double: 1 },
        back: { mode: 'same' },
      },
      null,
    );
    expect(withAddon.back).toEqual({ mode: 'same' });
    expect(withAddon.proof_back_url).toBeNull();
  });

  it('other: the template must be offered, PUBLISHED and of this store', async () => {
    const b = build();
    const make = (template_id: string) =>
      b.designs.create(
        STORE,
        {
          product_id: PRODUCT,
          template_version_id: V1,
          addons: { double: 1 },
          back: {
            mode: 'other',
            template_id,
            state: { v: 1, texts: {}, photos: {} },
          },
        },
        null,
      );
    expect(await codeOf(make(OTHER_TEMPLATE))).toBe('DESIGNER_BACK_INVALID');
    expect(await codeOf(make(UNPUBLISHED))).toBe('DESIGNER_BACK_INVALID');
    expect(await codeOf(make('not-a-uuid'))).toBe('DESIGNER_BACK_INVALID');
    const own = await make(TEMPLATE);
    expect(own.back).toMatchObject({
      mode: 'other',
      template_id: TEMPLATE,
      template_version_id: V1,
    });
    const other = await make(BACK_TEMPLATE);
    expect(other.back).toMatchObject({
      mode: 'other',
      template_id: BACK_TEMPLATE,
      template_version_id: BACK_V1,
    });
    expect(other.back_photos).toEqual({});
  });

  it('a malformed back is 400; back texts are validated against the back template', async () => {
    const b = build();
    expect(
      await codeOf(
        b.designs.create(
          STORE,
          {
            product_id: PRODUCT,
            template_version_id: V1,
            addons: { double: 1 },
            back: { mode: 'flip' },
          },
          null,
        ),
      ),
    ).toBe('DESIGNER_BACK_INVALID');
    expect(
      await codeOf(
        b.designs.create(
          STORE,
          {
            product_id: PRODUCT,
            template_version_id: V1,
            addons: { double: 1 },
            back: {
              mode: 'other',
              template_id: BACK_TEMPLATE,
              state: {
                v: 1,
                texts: { text: 'far too long for ten' },
                photos: {},
              },
            },
          },
          null,
        ),
      ),
    ).toBe('DESIGNER_STATE_INVALID');
  });

  it('deselecting the enabling add-on clears the back; the back photo route fills the back state', async () => {
    const b = build();
    const { id, access, view } = await completeFront(b);
    let v = await b.designs.update(
      STORE,
      id,
      {
        state: view.state,
        state_version: view.state_version,
        back: {
          mode: 'other',
          template_id: BACK_TEMPLATE,
          state: { v: 1, texts: { text: 'Hej' }, photos: {} },
        },
      },
      access,
    );
    expect(v.back).toMatchObject({
      mode: 'other',
      state: { texts: { text: 'Hej' } },
    });
    const up = await b.designs.uploadPhoto(
      STORE,
      id,
      'bild',
      Buffer.from('y'),
      access,
      'back',
    );
    expect(up.design.back).toMatchObject({
      mode: 'other',
      state: { photos: { bild: { asset_id: up.asset_id } } },
    });
    expect(up.design.back_photos?.bild.preview_url).toContain(up.asset_id);
    // The front state is untouched by a back upload.
    expect(Object.keys(up.design.state.photos)).toEqual(['foto']);
    // A front slot is not a back slot and vice versa.
    expect(
      await codeOf(
        b.designs.uploadPhoto(
          STORE,
          id,
          'foto',
          Buffer.from('y'),
          access,
          'back',
        ),
      ),
    ).toBe('DESIGNER_STATE_INVALID');
    // Deleting the back photo removes it from the back state.
    v = await b.designs.deletePhoto(STORE, id, up.asset_id, access);
    expect(v.back).toMatchObject({ mode: 'other', state: { photos: {} } });
    // Deselecting the add-on (keeping the state) drops the back entirely.
    v = await b.designs.update(
      STORE,
      id,
      { state: v.state, state_version: v.state_version, addons: {} },
      access,
    );
    expect(v).not.toHaveProperty('back');
    // The double stores Prisma.DbNull as an object; the real column is NULL.
    expect(
      readBack(b.db.design.find((x) => x.id === id)!.back) || null,
    ).toBeNull();
    // Re-selecting it does not bring the back back (the editor sends it again).
    v = await b.designs.update(
      STORE,
      id,
      { state: v.state, state_version: v.state_version, addons: { double: 1 } },
      access,
    );
    expect(v).not.toHaveProperty('back');
  });

  it('a back photo of the wrong design is refused; duplicate copies the back', async () => {
    const b = build();
    (b.assets as unknown as { readAssetBytes: unknown }).readAssetBytes =
      jest.fn(() => Promise.resolve(Buffer.from('bytes')));
    const a = await completeFront(b);
    const other = await completeFront(b);
    const up = await b.designs.uploadPhoto(
      STORE,
      other.id,
      'foto',
      Buffer.from('z'),
      other.access,
    );
    expect(
      await codeOf(
        b.designs.update(
          STORE,
          a.id,
          {
            state: a.view.state,
            state_version: a.view.state_version,
            back: {
              mode: 'other',
              template_id: BACK_TEMPLATE,
              state: {
                v: 1,
                texts: {},
                photos: {
                  bild: {
                    asset_id: up.asset_id,
                    width: 1,
                    height: 1,
                    adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
                  },
                },
              },
            },
          },
          a.access,
        ),
      ),
    ).toBe('DESIGNER_STATE_INVALID');
    const v = await b.designs.update(
      STORE,
      a.id,
      {
        state: a.view.state,
        state_version: a.view.state_version,
        back: {
          mode: 'other',
          template_id: BACK_TEMPLATE,
          state: { v: 1, texts: { text: 'Hej' }, photos: {} },
        },
      },
      a.access,
    );
    const backUp = await b.designs.uploadPhoto(
      STORE,
      a.id,
      'bild',
      Buffer.from('y'),
      a.access,
      'back',
    );
    expect(v.state_version).toBeLessThan(backUp.design.state_version);
    const copy = await b.designs.duplicate(STORE, a.id, a.access);
    expect(copy.back).toMatchObject({
      mode: 'other',
      template_id: BACK_TEMPLATE,
      state: { texts: { text: 'Hej' } },
    });
    const copied = (
      copy.back as { state: { photos: Record<string, { asset_id: string }> } }
    ).state.photos.bild;
    expect(copied.asset_id).not.toBe(backUp.asset_id);
    expect(
      b.db.designAsset.find((x) => x.id === copied.asset_id)!.design_id,
    ).toBe(copy.id);
  });
});

describe('DesignerCartService back side (M5.6)', () => {
  it('rule 4 applies to the back: an incomplete back is STATE_INVALID with back:<id> details', async () => {
    const b = build();
    const { id, access, view } = await completeFront(b);
    await b.designs.update(
      STORE,
      id,
      {
        state: view.state,
        state_version: view.state_version,
        back: {
          mode: 'other',
          template_id: BACK_TEMPLATE,
          state: { v: 1, texts: {}, photos: {} },
        },
      },
      access,
    );
    let details: unknown;
    try {
      await b.cart.planLines(STORE, [{ product_id: PRODUCT, design_id: id }], {
        mode: 'order',
        customerId: CUSTOMER,
      });
    } catch (e) {
      details = (e as { getResponse: () => { details: unknown } }).getResponse()
        .details;
    }
    expect(details).toEqual(
      expect.arrayContaining([
        { element_id: 'back:bild', rule: 'photo_required' },
        { element_id: 'back:text', rule: 'required' },
      ]),
    );
  });

  it('freeze: the snapshot carries the back spec + state, tagged assets, back text rows and the back proof', async () => {
    const b = build();
    const { id, access, view } = await completeFront(b);
    await b.designs.update(
      STORE,
      id,
      {
        state: view.state,
        state_version: view.state_version,
        back: {
          mode: 'other',
          template_id: BACK_TEMPLATE,
          state: { v: 1, texts: { text: 'Hej' }, photos: {} },
        },
      },
      access,
    );
    const up = await b.designs.uploadPhoto(
      STORE,
      id,
      'bild',
      Buffer.from('y'),
      access,
      'back',
    );
    const [line] = await b.cart.planLines(
      STORE,
      [{ product_id: PRODUCT, design_id: id }],
      {
        mode: 'order',
        customerId: CUSTOMER,
      },
    );
    expect(line!.back).toMatchObject({
      mode: 'other',
      version: { id: BACK_V1 },
    });
    const snap = await b.cart.snapshot(line!, {
      orderId: 'o',
      storeId: STORE,
      locale: 'sv',
    });
    expect(snap.create).toMatchObject({
      back_mode: 'other',
      back_template_id: BACK_TEMPLATE,
      back_template_version_id: BACK_V1,
      back_state: {
        texts: { text: 'Hej' },
        photos: { bild: { asset_id: up.asset_id } },
      },
      proof_back_key: null,
    });
    expect(
      (snap.create.back_template_spec as { surfaces: unknown[] }).surfaces,
    ).toHaveLength(1);
    const assets = snap.create.assets as {
      asset_id: string;
      role: string;
      side?: string;
    }[];
    expect(assets.find((a) => a.asset_id === up.asset_id)).toMatchObject({
      role: 'photo',
      side: 'back',
      element_id: 'bild',
    });
    expect(assets.filter((a) => a.role === 'photo' && !a.side)).toHaveLength(1);
    const texts = snap.create.text_values as {
      element_id: string;
      side?: string;
      value: string;
    }[];
    expect(texts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ element_id: 'namn', value: 'Anna' }),
        expect.objectContaining({
          element_id: 'back:text',
          value: 'Hej',
          side: 'back',
        }),
      ]),
    );
    const row = snap.designTexts.find((t) => t.element_id === 'back:text')!;
    expect(row.label.sv).toBe('Baksida: Namn');
    expect(row.value).toBe('Hej');
    // Cart view flags the line double-sided.
    const views = await b.cart.cartDesigns([id], 'sv');
    expect(views.get(id)).toMatchObject({
      double_sided: true,
      proof_back_url: null,
    });
    expect(views.get(id)!.invalid).toBeUndefined();
  });

  it('mode same freezes the front again as the back; single-sided snapshots have no back keys (G0)', async () => {
    const b = build();
    const { id, access, view } = await completeFront(b);
    await b.designs.update(
      STORE,
      id,
      {
        state: view.state,
        state_version: view.state_version,
        back: { mode: 'same' },
      },
      access,
    );
    const [line] = await b.cart.planLines(
      STORE,
      [{ product_id: PRODUCT, design_id: id }],
      {
        mode: 'order',
        customerId: CUSTOMER,
      },
    );
    const snap = await b.cart.snapshot(line!, { orderId: 'o', storeId: STORE });
    expect(snap.create).toMatchObject({
      back_mode: 'same',
      back_template_id: TEMPLATE,
      back_template_version_id: V1,
      back_state: line!.state,
    });
    expect(snap.create.back_template_spec).toEqual(snap.create.template_spec);
    // No duplicated text rows for 'same'.
    expect(
      snap.designTexts.filter((t) => t.element_id.startsWith('back:')),
    ).toHaveLength(0);

    const single = await completeFront(b);
    const [plain] = await b.cart.planLines(
      STORE,
      [{ product_id: PRODUCT, design_id: single.id }],
      {
        mode: 'order',
        customerId: CUSTOMER,
      },
    );
    const plainSnap = await b.cart.snapshot(plain!, {
      orderId: 'o',
      storeId: STORE,
    });
    expect(plainSnap.create).not.toHaveProperty('back_mode');
    expect(plainSnap.create).not.toHaveProperty('back_state');
    const views = await b.cart.cartDesigns([single.id], 'sv');
    expect(views.get(single.id)).not.toHaveProperty('double_sided');
  });

  it('a back template the merchant stopped offering makes the line a TEMPLATE_MISMATCH', async () => {
    const b = build();
    const { id, access, view } = await completeFront(b);
    await b.designs.update(
      STORE,
      id,
      {
        state: view.state,
        state_version: view.state_version,
        back: {
          mode: 'other',
          template_id: BACK_TEMPLATE,
          state: { v: 1, texts: { text: 'Hej' }, photos: {} },
        },
      },
      access,
    );
    await b.designs.uploadPhoto(
      STORE,
      id,
      'bild',
      Buffer.from('y'),
      access,
      'back',
    );
    b.db.productDesigner[0].back_template_ids = [];
    expect(
      await codeOf(
        b.cart.planLines(STORE, [{ product_id: PRODUCT, design_id: id }], {
          mode: 'order',
          customerId: CUSTOMER,
        }),
      ),
    ).toBe('DESIGNER_TEMPLATE_MISMATCH');
    const views = await b.cart.cartDesigns([id], 'sv');
    expect(views.get(id)).toMatchObject({
      invalid: true,
      invalid_code: 'DESIGNER_TEMPLATE_MISMATCH',
    });
  });
});
