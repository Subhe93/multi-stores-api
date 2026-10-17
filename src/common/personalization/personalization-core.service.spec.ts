import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerUploadsService } from '../../modules/customer-uploads/customer-uploads.service';
import {
  PersonalizationCoreService,
  type LineContext,
  type CoreFieldDef,
} from './personalization-core.service';
import {
  isSnapshotFileRow,
  snapshotLabel,
  sortSnapshotRows,
} from './snapshot-label';
import {
  cartRowLineKey,
  filterKnownFields,
  storedCustomFields,
} from './cart-line-key';
import { Prisma } from '@prisma/client';

const field = (over: Partial<CoreFieldDef>): CoreFieldDef => ({
  id: 'f1',
  name: 'name_1',
  type: 'TEXT',
  is_required: false,
  options: null,
  validation_rules: null,
  linked_validation: null,
  sort_order: 0,
  translations: [],
  ...over,
});

function makeCore(prisma: Record<string, unknown> = {}) {
  const uploads = new CustomerUploadsService(
    prisma as unknown as PrismaService,
  );
  return new PersonalizationCoreService(
    prisma as unknown as PrismaService,
    uploads,
  );
}

describe('PersonalizationCoreService.loadContexts', () => {
  it('batches: one query per table for N lines, contexts index-aligned', async () => {
    const prisma = {
      customProduct: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              id: 'cp1',
              product_id: 'p2',
              field_values: [
                { custom_field_id: 'g1', value: null, file_url: '/x.png' },
                { custom_field_id: 'g2', value: '', file_url: null },
              ],
            },
          ]),
        ),
      },
      productCustomField: {
        findMany: jest.fn(() =>
          Promise.resolve([
            { ...field({ id: 'f1' }), product_id: 'p1' },
            { ...field({ id: 'g1', name: 'logo' }), product_id: 'p2' },
          ]),
        ),
      },
    };
    const core = makeCore(prisma);
    const ctxs = await core.loadContexts([
      { product_id: 'p1' },
      { custom_product_id: 'cp1' },
      { product_id: 'p1' },
      { product_id: null },
    ]);
    expect(prisma.customProduct.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productCustomField.findMany).toHaveBeenCalledTimes(1);
    // Deterministic field order: sort_order, then id.
    expect(prisma.productCustomField.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(ctxs.map((c) => c.productId)).toEqual(['p1', 'p2', 'p1', null]);
    expect(ctxs[1].prefilled).toEqual({ g1: '/x.png' });
    expect(ctxs[3].fields).toEqual([]);
  });

  it('no custom products and no product ids: no query at all', async () => {
    const prisma = {
      customProduct: { findMany: jest.fn() },
      productCustomField: { findMany: jest.fn() },
    };
    await makeCore(prisma).loadContexts([{ product_id: null }]);
    expect(prisma.customProduct.findMany).not.toHaveBeenCalled();
    expect(prisma.productCustomField.findMany).not.toHaveBeenCalled();
  });
});

describe('PersonalizationCoreService.assertLine', () => {
  const ctx = (fields: CoreFieldDef[], prefilled = {}): LineContext => ({
    productId: 'p1',
    fields,
    prefilled,
  });
  const core = makeCore();

  it('no fields: {} and no check (G0)', () => {
    expect(core.assertLine({ any: 'thing' }, ctx([]))).toEqual({});
    expect(core.assertLine('garbage', ctx([]))).toEqual({});
  });

  it('drops unknown keys and returns normalized values', () => {
    expect(
      core.assertLine({ f1: '  Anna ', stale: 'x' }, ctx([field({})])),
    ).toEqual({ f1: 'Anna' });
  });

  it('prefilled values are injected over what the buyer sent', () => {
    expect(
      core.assertLine(
        { f1: 'tampered' },
        ctx([field({ is_required: true })], { f1: 'Creator' }),
      ),
    ).toEqual({ f1: 'Creator' });
  });

  it('localized label in params, en fallback, then name', () => {
    const f = field({
      is_required: true,
      translations: [
        { locale: 'en', label: 'Name' },
        { locale: 'sv', label: 'Namn' },
      ],
    });
    const run = (locale?: string) => {
      try {
        core.assertLine({}, ctx([f]), locale, { line_index: 2 });
      } catch (e) {
        return (e as BadRequestException).getResponse() as Record<
          string,
          unknown
        >;
      }
      throw new Error('no error');
    };
    expect(run('sv')).toMatchObject({
      code: 'CUSTOM_FIELD_REQUIRED',
      params: { label: 'Namn' },
      line_index: 2,
    });
    expect(run('de')).toMatchObject({ params: { label: 'Name' } });
    expect(run('de')).not.toHaveProperty('line_id');
  });

  describe('file references', () => {
    const img = ctx([field({ type: 'IMAGE' })]);
    const path = '/uploads/custom-fields/a.webp';
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('relative paths are accepted', () => {
      expect(core.assertLine({ f1: path }, img)).toEqual({ f1: path });
    });

    it('absolute URLs must use a configured API origin', () => {
      process.env.PUBLIC_API_URL = 'https://api.namez.se';
      process.env.API_PUBLIC_ORIGINS = 'https://cdn.namez.se, bad url';
      expect(
        core.assertLine({ f1: `https://api.namez.se${path}` }, img),
      ).toBeDefined();
      expect(
        core.assertLine({ f1: `https://cdn.namez.se${path}` }, img),
      ).toBeDefined();
      expect(() =>
        core.assertLine({ f1: `https://evil.example${path}` }, img),
      ).toThrow(BadRequestException);
    });

    it('without any configured origin only the path is checked (development)', () => {
      delete process.env.PUBLIC_API_URL;
      delete process.env.API_PUBLIC_ORIGINS;
      process.env.NODE_ENV = 'development';
      expect(
        core.assertLine({ f1: `https://anything.example${path}` }, img),
      ).toBeDefined();
    });

    it('in production without any configured origin absolute URLs fail closed', () => {
      delete process.env.PUBLIC_API_URL;
      delete process.env.API_PUBLIC_ORIGINS;
      process.env.NODE_ENV = 'production';
      expect(() =>
        core.assertLine({ f1: `https://anything.example${path}` }, img),
      ).toThrow(BadRequestException);
      expect(core.assertLine({ f1: path }, img)).toEqual({ f1: path });
    });
  });
});

describe('PersonalizationCoreService.valuesFromLegacyDto', () => {
  it('maps value ?? file_url and collects repeated ids', () => {
    expect(
      makeCore().valuesFromLegacyDto([
        { custom_field_id: 'a', value: 'x' },
        { custom_field_id: 'b', file_url: '/1' },
        { custom_field_id: 'b', file_url: '/2' },
        { custom_field_id: 'b', file_url: '/3' },
        { custom_field_id: 'c', value: '' },
        // An empty value next to a file must not hide the file.
        { custom_field_id: 'd', value: '', file_url: '/4' },
      ]),
    ).toEqual({ a: 'x', b: ['/1', '/2', '/3'], d: '/4' });
  });
});

describe('PersonalizationCoreService.buildOrderValues', () => {
  const core = makeCore();
  const ctx = (fields: CoreFieldDef[]): LineContext => ({
    productId: 'p1',
    fields,
    prefilled: {},
  });

  it('classifies by type: text with http stays value, numbers stringified, IMAGE is file_url', () => {
    const rows = core.buildOrderValues(
      {},
      ctx([
        field({ id: 't', type: 'TEXT', sort_order: 0 }),
        field({ id: 'n', name: 'n', type: 'NUMBER', sort_order: 1 }),
        field({ id: 'i', name: 'i', type: 'IMAGE', sort_order: 2 }),
      ]),
      { t: 'http://my-site', n: 5, i: '/uploads/custom-fields/a.webp' },
    );
    expect(rows.map((r) => [r.custom_field_id, r.value, r.file_url])).toEqual([
      ['t', 'http://my-site', undefined],
      ['n', '5', undefined],
      ['i', undefined, '/uploads/custom-fields/a.webp'],
    ]);
  });

  it('no values: no rows', () => {
    expect(core.buildOrderValues({}, ctx([field({})]), {})).toEqual([]);
  });

  it('uploadIdsOf is unique', () => {
    expect(
      core.uploadIdsOf([
        { upload_id: 'a' },
        { upload_id: 'a' },
        { upload_id: null },
        {},
      ] as never),
    ).toEqual(['a']);
  });

  it('resolveUploads makes no call when the order has no preview URL', async () => {
    const uploads = new CustomerUploadsService({} as PrismaService);
    const spy = jest.spyOn(uploads, 'resolveForOrder');
    const c = new PersonalizationCoreService({} as PrismaService, uploads);
    const map = await c.resolveUploads(
      [
        {
          ctx: ctx([field({ type: 'IMAGE' })]),
          values: { f1: '/uploads/custom-fields/a.webp' },
        },
      ],
      's1',
    );
    expect(map.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('assertUploadsAvailable (quote): another store or a purged upload → CUSTOMER_UPLOAD_EXPIRED', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const url = `/uploads/customer-previews/${id}.webp`;
    const row = { id, purged_at: null as Date | null, store_id: 'other' };
    const prisma = {
      customerUpload: { findMany: jest.fn(() => Promise.resolve([row])) },
    };
    const c = makeCore(prisma);
    const line = {
      ctx: ctx([field({ type: 'IMAGE' })]),
      values: { f1: url },
      ref: { line_id: 'cart-row-1', line_index: 0 },
    };
    const err = await c
      .assertUploadsAvailable([line], 's1', 'en')
      .catch((e: BadRequestException) => e.getResponse());
    expect(err).toMatchObject({
      code: 'CUSTOMER_UPLOAD_EXPIRED',
      line_id: 'cart-row-1',
      line_index: 0,
    });
    row.store_id = 's1';
    await expect(
      c.assertUploadsAvailable([line], 's1', 'en'),
    ).resolves.toBeUndefined();
    row.purged_at = new Date();
    await expect(c.assertUploadsAvailable([line], 's1', 'en')).rejects.toThrow(
      BadRequestException,
    );
    // No preview URL: no query.
    prisma.customerUpload.findMany.mockClear();
    await c.assertUploadsAvailable(
      [{ ...line, values: { f1: '/uploads/custom-fields/a.webp' } }],
      's1',
    );
    expect(prisma.customerUpload.findMany).not.toHaveBeenCalled();
  });
});

describe('snapshotLabel', () => {
  const live = {
    name: 'live_name',
    type: 'SELECT',
    translations: [
      { locale: 'en', label: 'Live label', option_labels: { S: 'Small' } },
    ],
  };

  it('snapshot label by locale → primary → en → first', () => {
    const row = { field_label: { sv: 'Namn', en: 'Name', de: 'Name DE' } };
    expect(snapshotLabel(row, 'sv').label).toBe('Namn');
    expect(snapshotLabel(row, 'fr', 'de').label).toBe('Name DE');
    expect(snapshotLabel(row, 'fr').label).toBe('Name');
    expect(snapshotLabel({ field_label: { ar: 'اسم' } }, 'fr').label).toBe(
      'اسم',
    );
  });

  it('falls back to the live translation, then field_name, then the live name, then —', () => {
    expect(snapshotLabel({ custom_field: live }, 'sv').label).toBe(
      'Live label',
    );
    expect(snapshotLabel({ field_name: 'name_2' }, 'sv').label).toBe('name_2');
    expect(
      snapshotLabel({ custom_field: { name: 'n', translations: [] } }).label,
    ).toBe('n');
    expect(snapshotLabel({}).label).toBe('—');
  });

  it('a deleted field (custom_field null) still reads its snapshot', () => {
    expect(
      snapshotLabel(
        {
          custom_field: null,
          field_label: { sv: 'Andra texten' },
          value: 'OLLE',
        },
        'sv',
      ),
    ).toEqual({ label: 'Andra texten', value: 'OLLE' });
  });

  it('value: display_value chain, else live option label for pre-snapshot rows, else raw', () => {
    expect(
      snapshotLabel(
        { value: 'S', display_value: { sv: 'Liten', en: 'Small' } },
        'sv',
      ).value,
    ).toBe('Liten');
    expect(snapshotLabel({ value: 'S', custom_field: live }, 'sv').value).toBe(
      'Small',
    );
    expect(snapshotLabel({ value: 'M', custom_field: live }).value).toBe('M');
    expect(snapshotLabel({ file_url: '/a' }).value).toBeNull();
  });

  it('file rows and sorting', () => {
    expect(
      isSnapshotFileRow({ field_type: 'MULTI_IMAGE', file_url: '/a' }),
    ).toBe(true);
    expect(isSnapshotFileRow({ field_type: 'TEXT', value: 'x' })).toBe(false);
    expect(isSnapshotFileRow({ file_url: '/a' })).toBe(true);
    expect(
      sortSnapshotRows([
        { sort_order: null, k: 'c' },
        { sort_order: 2, k: 'b' },
        { sort_order: 1, k: 'a' },
        { sort_order: null, k: 'd' },
      ]).map((r) => r.k),
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('cart line key helpers', () => {
  const ids = new Set(['f1', 'f2']);

  it('a legacy row with unnormalized JSON and stale keys matches the new key', () => {
    expect(cartRowLineKey({ f1: 'Anna ', stale: 'x' }, ids)).toBe(
      cartRowLineKey({ f1: 'Anna' }, ids),
    );
    expect(cartRowLineKey(null, ids)).toBe('');
    expect(cartRowLineKey({}, ids)).toBe('');
    expect(filterKnownFields('x', ids)).toEqual({});
  });

  it('storedCustomFields keeps G0 shapes', () => {
    expect(storedCustomFields(undefined, {})).toBeUndefined();
    const empty = {};
    expect(storedCustomFields(empty, {})).toBe(empty);
    expect(storedCustomFields(null, {})).toBe(Prisma.DbNull);
    expect(storedCustomFields({ stale: 'x' }, {})).toBe(Prisma.DbNull);
    expect(storedCustomFields({ f1: ' A ' }, { f1: 'A' })).toEqual({ f1: 'A' });
    // A product without fields stores the sent object verbatim (pre-M4.0).
    const sent = { anything: ' kept ', nested: { a: 1 } };
    expect(storedCustomFields(sent, {}, false)).toBe(sent);
    expect(storedCustomFields(null, {}, false)).toBe(Prisma.DbNull);
    expect(storedCustomFields(undefined, {}, false)).toBeUndefined();
  });
});

describe('PersonalizationCoreService.loadContexts variant lines (M4.1 fixes)', () => {
  const prismaWith = () => ({
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    productVariant: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 'v1', product_id: 'p1' },
          { id: 'v2', product_id: 'p2' },
        ]),
      ),
    },
    productCustomField: {
      findMany: jest.fn(() =>
        Promise.resolve([{ ...field({ id: 'f1' }), product_id: 'p1' }]),
      ),
    },
  });

  it('a variant-only line gets the variant product; variants are read in one query', async () => {
    const prisma = prismaWith();
    const ctxs = await makeCore(prisma).loadContexts([
      { variant_id: 'v1' },
      { product_id: 'p1', variant_id: 'v1' },
      { variant_id: 'v2' },
    ]);
    expect(ctxs.map((c) => c.productId)).toEqual(['p1', 'p1', 'p2']);
    expect(ctxs[0].fields.map((f) => f.id)).toEqual(['f1']);
    expect(prisma.productVariant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productVariant.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['v1', 'v2'] } },
      select: { id: true, product_id: true },
    });
  });

  it('M5 A11: lines with a product_id make no variant query (the callers check ownership)', async () => {
    const prisma = prismaWith();
    const ctxs = await makeCore(prisma).loadContexts([
      { product_id: 'p1', variant_id: 'v2' },
      { product_id: 'p1', variant_id: 'v1' },
    ]);
    expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
    expect(ctxs.map((c) => c.productId)).toEqual(['p1', 'p1']);
  });

  it('lines without a variant make no variant query (M4.0 budget unchanged)', async () => {
    const prisma = prismaWith();
    await makeCore(prisma).loadContexts([{ product_id: 'p1' }]);
    expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
  });
});
