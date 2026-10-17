/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { Prisma, UserRole } from '@prisma/client';
import { CustomFieldsService } from './custom-fields.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';

// M4.1 WP-B: advanced config is gated by the personalization app on the
// creator's own products; app-off writes stay on today's path; update
// carries the M4.1 translation columns over (X19); names are unique per
// sibling set (C16).

const OPTION_CONFIG = [
  { name: 'Välj antal', values: ['1 produkt', '2 produkter'] },
  { name: 'Färg', values: ['Röd', 'Blå'] },
];

type Stored = Record<string, unknown>;

function setup(
  opts: {
    appOn?: boolean;
    creatorProduct?: boolean;
    field?: Stored;
    translations?: Stored[];
    siblings?: Stored[];
    clash?: boolean;
  } = {},
) {
  const field: Stored = {
    id: 'f1',
    product_id: 'p1',
    name: 'name_1',
    type: 'TEXT',
    parent_id: null,
    sort_order: 0,
    options: null,
    validation_rules: null,
    linked_validation: null,
    conditions: null,
    pricing: null,
    repeat: null,
    ui: null,
    ...opts.field,
  };
  const siblings: Stored[] = opts.siblings ?? [
    field,
    {
      id: 'r1',
      name: 'dnc_items',
      type: 'REPEATER',
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 'other-child',
      name: 'color',
      type: 'COLOR_PALETTE',
      parent_id: 'r1',
      sort_order: 0,
    },
  ];
  const prisma = {
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          provider:
            opts.creatorProduct === false ? { user_id: 'u-prov' } : null,
          creator:
            opts.creatorProduct === false ? null : { user_id: 'u-creator' },
          creator_id: opts.creatorProduct === false ? null : 'c1',
          variant_option_config: OPTION_CONFIG,
        }),
      ),
    },
    store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
    productCustomField: {
      findUnique: jest.fn(() => Promise.resolve(field)),
      findFirst: jest.fn(() =>
        Promise.resolve(opts.clash ? { id: 'x' } : null),
      ),
      findMany: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          siblings.filter(
            (s) =>
              !('parent_id' in args.where) ||
              (s.parent_id ?? null) === args.where.parent_id,
          ),
        ),
      ),
      aggregate: jest.fn(() => Promise.resolve({ _max: { sort_order: null } })),
      create: jest.fn((args: unknown) => Promise.resolve({ id: 'new', args })),
      update: jest.fn((args: unknown) => Promise.resolve({ id: 'f1', args })),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      delete: jest.fn(() => Promise.resolve({ id: 'f1' })),
    },
    customFieldTranslation: {
      findMany: jest.fn(() => Promise.resolve(opts.translations ?? [])),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    // Per-product field lock (advisory lock) and the store app settings.
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    storeApp: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  const storeApps = { isEnabled: jest.fn(() => Promise.resolve(!!opts.appOn)) };
  const revalidation = {
    revalidateStoreByCreatorId: jest.fn(() => Promise.resolve()),
  };
  const service = new CustomFieldsService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    revalidation as unknown as RevalidationService,
  );
  return { prisma, storeApps, service, revalidation };
}

const CREATOR = ['u-creator', UserRole.CREATOR] as const;

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return {
      status: (e as { getStatus(): number }).getStatus(),
      body: (e as { getResponse(): Record<string, unknown> }).getResponse(),
    };
  }
  return null;
}

type Args = { data: Record<string, unknown> };
const createArgs = (prisma: ReturnType<typeof setup>['prisma']) =>
  (prisma.productCustomField.create.mock.calls[0] as unknown[])[0] as Args;
const updateArgs = (prisma: ReturnType<typeof setup>['prisma']) =>
  (prisma.productCustomField.update.mock.calls[0] as unknown[])[0] as Args;

describe('CustomFieldsService personalization gate (M4.1)', () => {
  it('app off: a plain field is written exactly as before (no app lookup)', async () => {
    const { prisma, storeApps, service } = setup();
    await service.create(
      'p1',
      {
        name: 'name_3',
        type: 'TEXT',
        is_required: true,
        translations: [{ locale: 'sv', label: 'Namn' }],
      } as never,
      ...CREATOR,
    );
    expect(createArgs(prisma)).toEqual({
      data: {
        product_id: 'p1',
        name: 'name_3',
        type: 'TEXT',
        is_required: true,
        sort_order: 0,
        translations: { create: [{ locale: 'sv', label: 'Namn' }] },
      },
      include: { translations: true },
    });
    expect(Object.keys(createArgs(prisma).data).sort()).toEqual(
      [
        'is_required',
        'name',
        'product_id',
        'sort_order',
        'translations',
        'type',
      ].sort(),
    );
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
    expect(prisma.productCustomField.aggregate).toHaveBeenCalledWith({
      where: { product_id: 'p1' },
      _max: { sort_order: true },
    });
  });

  it.each([
    ['ui', { ui: { placement: 'after_variants' } }],
    [
      'conditions',
      {
        conditions: {
          match: 'all',
          rules: [{ source: 'option', key: 'Färg', op: 'set' }],
        },
      },
    ],
    ['pricing', { pricing: { mode: 'fixed', amount: 5 } }],
    ['app-only type', { type: 'CHECKBOX_GROUP', options: ['A'] }],
    ['parent_id', { parent_id: 'r1' }],
    ['min_checked', { validation_rules: { min_checked: 1 } }],
    [
      'a translation extra',
      { translations: [{ locale: 'sv', label: 'x', sublabel: 'y' }] },
    ],
  ])(
    'app off: %s → 403 PERSONALIZATION_APP_REQUIRED',
    async (_label, extra) => {
      const { prisma, service } = setup();
      const err = await errorOf(
        service.create(
          'p1',
          { name: 'n', type: 'TEXT', ...extra } as never,
          ...CREATOR,
        ),
      );
      expect(err).toEqual({
        status: 403,
        body: expect.objectContaining({ code: 'PERSONALIZATION_APP_REQUIRED' }),
      });
      expect(prisma.productCustomField.create).not.toHaveBeenCalled();
    },
  );

  it('a provider product → 400 PERSONALIZATION_CREATOR_PRODUCT_ONLY (even with the app on)', async () => {
    const { service } = setup({ appOn: true, creatorProduct: false });
    const err = await errorOf(
      service.create(
        'p1',
        { name: 'n', type: 'TEXT', ui: { counter: true } } as never,
        'u-prov',
        UserRole.PROVIDER,
      ),
    );
    expect(err).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_CREATOR_PRODUCT_ONLY',
      }),
    });
  });

  it('app on: advanced config is stored; a bad config is 400 with errors[{path, code}]', async () => {
    const { prisma, storeApps, service } = setup({ appOn: true });
    await service.create(
      'p1',
      {
        name: 'color2',
        type: 'COLOR_PALETTE',
        parent_id: 'r1',
        ui: { palette_from_option: 'Färg' },
        translations: [
          {
            locale: 'sv',
            label: 'Färg',
            messages: { required: 'Artikel {i}: Färg måste väljas' },
          },
        ],
      } as never,
      ...CREATOR,
    );
    expect(storeApps.isEnabled).toHaveBeenCalledWith('s1', 'personalization');
    const data = createArgs(prisma).data;
    expect(data).toMatchObject({
      parent_id: 'r1',
      ui: { palette_from_option: 'Färg' },
      translations: {
        create: [
          {
            locale: 'sv',
            label: 'Färg',
            messages: { required: 'Artikel {i}: Färg måste väljas' },
          },
        ],
      },
    });
    // Child sort order is computed within the parent.
    expect(prisma.productCustomField.aggregate).toHaveBeenCalledWith({
      where: { product_id: 'p1', parent_id: 'r1' },
      _max: { sort_order: true },
    });

    const err = await errorOf(
      service.create(
        'p1',
        {
          name: 'x',
          type: 'TEXT',
          ui: { placement: 'top' },
          conditions: {
            match: 'all',
            rules: [{ source: 'option', key: 'Storlek', op: 'set' }],
          },
        } as never,
        ...CREATOR,
      ),
    );
    expect(err?.status).toBe(400);
    expect(err?.body).toMatchObject({
      code: 'PERSONALIZATION_CONFIG_INVALID',
      errors: expect.arrayContaining([
        { path: 'ui.placement', code: 'INVALID_VALUE' },
        {
          path: 'conditions.rules[0].key',
          code: 'UNKNOWN_OPTION',
          params: { key: 'Storlek' },
        },
      ]),
    });
  });

  it('app on: a parent from another product is refused (PARENT_NOT_FOUND)', async () => {
    const { service } = setup({ appOn: true });
    const err = await errorOf(
      service.create(
        'p1',
        { name: 'n', type: 'TEXT', parent_id: 'rep-of-p2' } as never,
        ...CREATOR,
      ),
    );
    expect(err?.body).toMatchObject({
      code: 'PERSONALIZATION_CONFIG_INVALID',
      errors: expect.arrayContaining([
        { path: 'parent_id', code: 'PARENT_NOT_FOUND' },
      ]),
    });
  });

  it('names are unique per sibling set (product, parent, name)', async () => {
    const { prisma, service } = setup({ appOn: true });
    await service.create(
      'p1',
      { name: 'name', type: 'TEXT', parent_id: 'r1' } as never,
      ...CREATOR,
    );
    expect(prisma.productCustomField.findFirst).toHaveBeenCalledWith({
      where: { product_id: 'p1', parent_id: 'r1', name: 'name' },
      select: { id: true },
    });
    const clash = setup({ appOn: true, clash: true });
    expect(
      (
        await errorOf(
          clash.service.create(
            'p1',
            { name: 'name_2', type: 'TEXT' } as never,
            ...CREATOR,
          ),
        )
      )?.body,
    ).toMatchObject({ code: 'CUSTOM_FIELD_NAME_TAKEN' });
    expect(clash.prisma.productCustomField.findFirst).toHaveBeenCalledWith({
      where: { product_id: 'p1', parent_id: null, name: 'name_2' },
      select: { id: true },
    });
  });
});

describe('CustomFieldsService update with stored M4.1 values (app off)', () => {
  const storedField = {
    type: 'TEXT',
    ui: { transform: 'uppercase', placement: 'after_variants' },
    conditions: {
      rules: [{ op: 'set', key: 'Färg', source: 'option' }],
      match: 'all',
    },
  };
  const storedTranslations = [
    {
      locale: 'sv',
      display_label: 'Namn',
      sublabel: 'Använd texten',
      note: null,
      help_text: 'Exempel:\nA',
      help_image_url: 'https://cdn.example/a.jpg',
      messages: { required: 'Ange ett värde.' },
    },
  ];

  it('accepts unchanged advanced values round-tripped by the app-off editor (key order ignored)', async () => {
    const { prisma, storeApps, service } = setup({
      field: storedField,
      translations: storedTranslations,
    });
    await service.update(
      'f1',
      {
        name: 'name_1',
        ui: { placement: 'after_variants', transform: 'uppercase' },
        conditions: {
          match: 'all',
          rules: [{ source: 'option', key: 'Färg', op: 'set' }],
        },
        translations: [
          {
            locale: 'sv',
            label: 'Första',
            display_label: 'Namn',
            sublabel: 'Använd texten',
            help_text: 'Exempel:\nA',
            help_image_url: 'https://cdn.example/a.jpg',
            messages: { required: 'Ange ett värde.' },
          },
        ],
      } as never,
      ...CREATOR,
    );
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
    expect(prisma.productCustomField.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed advanced value with the app off (403)', async () => {
    const { prisma, service } = setup({
      field: storedField,
      translations: storedTranslations,
    });
    expect(
      (
        await errorOf(
          service.update(
            'f1',
            { ui: { placement: 'before_variants' } } as never,
            ...CREATOR,
          ),
        )
      )?.body,
    ).toMatchObject({ code: 'PERSONALIZATION_APP_REQUIRED' });
    expect(
      (
        await errorOf(
          service.update(
            'f1',
            {
              translations: [{ locale: 'sv', label: 'x', sublabel: 'Ny text' }],
            } as never,
            ...CREATOR,
          ),
        )
      )?.body,
    ).toMatchObject({ code: 'PERSONALIZATION_APP_REQUIRED' });
    expect(prisma.productCustomField.update).not.toHaveBeenCalled();
  });

  it('clearing advanced values (null) is always allowed and writes SQL NULL', async () => {
    const { prisma, service } = setup({ field: storedField });
    await service.update(
      'f1',
      { ui: null, conditions: null, preset_key: null } as never,
      ...CREATOR,
    );
    expect(updateArgs(prisma).data).toEqual({
      ui: Prisma.DbNull,
      conditions: Prisma.DbNull,
      preset_key: null,
    });
  });

  it('X19: omitted translation columns are carried over, null clears, other locales start empty', async () => {
    const { prisma, service } = setup({
      field: storedField,
      translations: storedTranslations,
    });
    await service.update(
      'f1',
      {
        translations: [
          {
            locale: 'sv',
            label: 'Första texten',
            placeholder: 'KRISTOFER',
            sublabel: null,
          },
          { locale: 'en', label: 'First text' },
        ],
      } as never,
      ...CREATOR,
    );
    expect(prisma.customFieldTranslation.deleteMany).toHaveBeenCalledWith({
      where: { field_id: 'f1' },
    });
    const created = (
      updateArgs(prisma).data.translations as { create: unknown[] }
    ).create;
    expect(created).toEqual([
      {
        locale: 'sv',
        label: 'Första texten',
        placeholder: 'KRISTOFER',
        display_label: 'Namn',
        help_text: 'Exempel:\nA',
        help_image_url: 'https://cdn.example/a.jpg',
        messages: { required: 'Ange ett värde.' },
      },
      { locale: 'en', label: 'First text' },
    ]);
  });

  it('a plain update without translations does not read them (unchanged M4.0 path)', async () => {
    const { prisma, service } = setup();
    await service.update('f1', { is_required: true }, ...CREATOR);
    expect(prisma.customFieldTranslation.findMany).not.toHaveBeenCalled();
    expect(updateArgs(prisma).data).toEqual({ is_required: true });
  });

  it('parent_id cannot be changed on update', async () => {
    const { service } = setup();
    expect(
      (
        await errorOf(
          service.update('f1', { parent_id: 'r1' } as never, ...CREATOR),
        )
      )?.body,
    ).toMatchObject({
      code: 'PERSONALIZATION_CONFIG_INVALID',
      errors: [{ path: 'parent_id', code: 'PARENT_IMMUTABLE' }],
    });
  });

  it('a REPEATER with children cannot change type', async () => {
    const { service } = setup({
      field: { id: 'r1', name: 'dnc_items', type: 'REPEATER' },
      siblings: [
        {
          id: 'r1',
          name: 'dnc_items',
          type: 'REPEATER',
          parent_id: null,
          sort_order: 0,
        },
        {
          id: 'c',
          name: 'color',
          type: 'COLOR_PALETTE',
          parent_id: 'r1',
          sort_order: 0,
        },
      ],
    });
    expect(
      (
        await errorOf(
          service.update('r1', { type: 'TEXT' } as never, ...CREATOR),
        )
      )?.body,
    ).toMatchObject({
      code: 'PERSONALIZATION_CONFIG_INVALID',
      errors: expect.arrayContaining([
        { path: 'type', code: 'REPEATER_HAS_CHILDREN' },
      ]),
    });
  });

  it('a rename also moves field-source conditions and repeater lead lists', async () => {
    const { prisma, service } = setup({
      field: { name: 'custom_name_v3' },
      siblings: [
        {
          id: 'f1',
          name: 'custom_name_v3',
          parent_id: null,
          linked_validation: null,
          conditions: null,
          repeat: null,
        },
        {
          id: 'r1',
          name: 'dnc_items',
          parent_id: null,
          linked_validation: null,
          conditions: {
            match: 'all',
            rules: [{ source: 'field', key: 'custom_name_v3', op: 'set' }],
          },
          repeat: {
            count: { option: 'Välj antal' },
            start_index: 2,
            max: 5,
            lead: { fields: ['custom_name_v3'], options: ['Färg'] },
          },
        },
      ],
    });
    await service.update('f1', { name: 'namn' }, ...CREATOR);
    const calls = prisma.productCustomField.update.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as {
          where: { id: string };
          data: Record<string, unknown>;
        },
    );
    expect(calls[1]).toEqual({
      where: { id: 'r1' },
      data: {
        conditions: {
          match: 'all',
          rules: [{ source: 'field', key: 'namn', op: 'set' }],
        },
        repeat: {
          count: { option: 'Välj antal' },
          start_index: 2,
          max: 5,
          lead: { fields: ['namn'], options: ['Färg'] },
        },
      },
    });
  });
});

describe('CustomFieldsService M4.1 fixes', () => {
  const many = (n: number, parent: string | null = null) =>
    Array.from({ length: n }, (_, i) => ({
      id: `x${i}`,
      name: `x${i}`,
      type: 'TEXT',
      parent_id: parent,
      sort_order: i,
    }));

  it('create takes the per-product field lock (same as presets)', async () => {
    const { prisma, service } = setup();
    await service.create(
      'p1',
      { name: 'n', type: 'TEXT' } as never,
      ...CREATOR,
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = prisma.$executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql[0].join('?')).toContain('pg_advisory_xact_lock');
    expect(sql[1]).toBe('pfields:p1');
  });

  it('update takes the lock and reads the stored translations inside the transaction', async () => {
    const { prisma, service } = setup();
    let inTx = false;
    prisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        inTx = true;
        try {
          return await fn(prisma);
        } finally {
          inTx = false;
        }
      },
    );
    let readInTx = false;
    prisma.customFieldTranslation.findMany.mockImplementation(() => {
      readInTx = inTx;
      return Promise.resolve([]);
    });
    await service.update(
      'f1',
      { translations: [{ locale: 'sv', label: 'x' }] } as never,
      ...CREATOR,
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(readInTx).toBe(true);
  });

  it('100 fields per product → 400 PERSONALIZATION_FIELD_LIMIT {max:100}', async () => {
    const { service, prisma } = setup({ siblings: many(100) });
    const err = await errorOf(
      service.create('p1', { name: 'n', type: 'TEXT' } as never, ...CREATOR),
    );
    expect(err).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_FIELD_LIMIT',
        params: { max: 100 },
      }),
    });
    expect(prisma.productCustomField.create).not.toHaveBeenCalled();
  });

  it('20 children per repeater → 400 PERSONALIZATION_FIELD_LIMIT {max:20}', async () => {
    const siblings = [
      {
        id: 'r1',
        name: 'dnc_items',
        type: 'REPEATER',
        parent_id: null,
        sort_order: 0,
      },
      ...many(20, 'r1'),
    ];
    const { service } = setup({ appOn: true, siblings });
    const err = await errorOf(
      service.create(
        'p1',
        { name: 'n', type: 'TEXT', parent_id: 'r1' } as never,
        ...CREATOR,
      ),
    );
    expect(err?.body).toMatchObject({
      code: 'PERSONALIZATION_FIELD_LIMIT',
      params: { max: 20 },
    });
  });

  it('an empty {} config is stored as NULL (no app needed)', async () => {
    const { prisma, service, storeApps } = setup({
      field: { ui: { placement: 'after_variants' } },
    });
    await service.create(
      'p1',
      { name: 'n', type: 'TEXT', ui: {}, pricing: {} } as never,
      ...CREATOR,
    );
    expect(createArgs(prisma).data).not.toHaveProperty('ui');
    expect(createArgs(prisma).data).not.toHaveProperty('pricing');
    await service.update('f1', { ui: {} } as never, ...CREATOR);
    expect(updateArgs(prisma).data).toEqual({ ui: Prisma.DbNull });
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
  });

  it('clearing the repeat config of a REPEATER is re-validated (REPEAT_REQUIRED)', async () => {
    const { prisma, service } = setup({
      field: {
        type: 'REPEATER',
        name: 'dnc_items',
        repeat: { count: { option: 'Välj antal' }, start_index: 2, max: 5 },
      },
    });
    const err = await errorOf(
      service.update('f1', { repeat: null } as never, ...CREATOR),
    );
    expect(err).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_CONFIG_INVALID',
        errors: [{ path: 'repeat', code: 'REPEAT_REQUIRED' }],
      }),
    });
    expect(prisma.productCustomField.update).not.toHaveBeenCalled();
  });

  it('deleting a referenced field → 409 PERSONALIZATION_FIELD_IN_USE {fields}', async () => {
    const { prisma, service } = setup({
      siblings: [
        { id: 'f1', name: 'name_1', parent_id: null },
        {
          id: 'f2',
          name: 'name_2',
          parent_id: null,
          linked_validation: { type: 'equal_length', target: 'name_1' },
        },
        {
          id: 'r1',
          name: 'dnc_items',
          parent_id: null,
          repeat: { lead: { fields: ['name_1'] } },
        },
      ],
    });
    prisma.storeApp.findUnique.mockResolvedValue({
      settings: { url_prefill: { name1: 'name_1', color: 'option:Färg' } },
    } as never);
    const err = await errorOf(service.delete('f1', ...CREATOR));
    expect(err).toEqual({
      status: 409,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_FIELD_IN_USE',
        params: { fields: ['name_2', 'dnc_items', 'url_prefill.name1'] },
      }),
    });
    expect(prisma.productCustomField.delete).not.toHaveBeenCalled();
  });

  it('url_prefill does not block a delete when another product still has the name', async () => {
    const { prisma, service } = setup({
      siblings: [{ id: 'f1', name: 'name_1', parent_id: null }],
      clash: true,
    });
    prisma.storeApp.findUnique.mockResolvedValue({
      settings: { url_prefill: { name1: 'name_1' } },
    } as never);
    await service.delete('f1', ...CREATOR);
    expect(prisma.productCustomField.delete).toHaveBeenCalledTimes(1);
  });

  it('a rename also renames the store url_prefill targets and drops the settings cache', async () => {
    const { prisma, service, storeApps } = setup({
      siblings: [{ id: 'f1', name: 'name_1', parent_id: null }],
    });
    const apps = storeApps as unknown as Record<string, jest.Mock>;
    apps.settingsChanged = jest.fn(() => Promise.resolve());
    prisma.storeApp.findUnique.mockResolvedValue({
      settings: {
        card_price_mode: 'from',
        url_prefill: { name1: 'name_1', color: 'option:Färg' },
      },
    } as never);
    await service.update('f1', { name: 'first_name' } as never, ...CREATOR);
    expect(prisma.storeApp.update).toHaveBeenCalledWith({
      where: {
        store_id_app_key: { store_id: 's1', app_key: 'personalization' },
      },
      data: {
        settings: {
          card_price_mode: 'from',
          url_prefill: { name1: 'first_name', color: 'option:Färg' },
        },
      },
    });
    expect(apps.settingsChanged).toHaveBeenCalledWith('s1');
  });

  it('M5 A4: a legacy link whose target_field_id holds the NAME follows a rename (and is migrated to target)', async () => {
    const { prisma, service } = setup({
      field: { name: 'name_1' },
      siblings: [
        { id: 'f1', name: 'name_1', parent_id: null, linked_validation: null },
        {
          id: 'f2',
          name: 'name_2',
          parent_id: null,
          // Written by the pre-K3 dashboard: the name, under the old key.
          linked_validation: {
            type: 'equal_length',
            target_field_id: 'name_1',
            fill_char: '\u2764',
          },
          conditions: null,
          repeat: null,
        },
      ],
    });
    await service.update('f1', { name: 'namn' }, ...CREATOR);
    const calls = prisma.productCustomField.update.mock.calls.map(
      (c) => (c as unknown[])[0] as { where: { id: string }; data: unknown },
    );
    expect(calls[1]).toEqual({
      where: { id: 'f2' },
      data: {
        linked_validation: {
          type: 'equal_length',
          target: 'namn',
          fill_char: '\u2764',
        },
      },
    });
  });

  it('M5 A4: deleting the target of a legacy name link → 409 PERSONALIZATION_FIELD_IN_USE', async () => {
    const { prisma, service } = setup({
      siblings: [
        { id: 'f1', name: 'name_1', parent_id: null },
        {
          id: 'f2',
          name: 'name_2',
          parent_id: null,
          linked_validation: {
            type: 'equal_length',
            target_field_id: 'name_1',
          },
        },
      ],
    });
    const err = await errorOf(service.delete('f1', ...CREATOR));
    expect(err).toEqual({
      status: 409,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_FIELD_IN_USE',
        params: { fields: ['name_2'] },
      }),
    });
    expect(prisma.productCustomField.delete).not.toHaveBeenCalled();
  });

  it('M5 A13: an update with only sort_order re-validates FORWARD_REFERENCE', async () => {
    const siblings = [
      {
        id: 'f1',
        name: 'name_1',
        type: 'TEXT',
        parent_id: null,
        sort_order: 0,
      },
      {
        id: 'f2',
        name: 'gift',
        type: 'TEXT',
        parent_id: null,
        sort_order: 1,
        conditions: {
          match: 'all',
          rules: [{ source: 'field', key: 'name_1', op: 'set' }],
        },
      },
    ];
    const { prisma, service } = setup({
      field: { id: 'f1', name: 'name_1', sort_order: 0 },
      siblings,
    });
    // Moving name_1 after gift makes gift's reference a forward one.
    const err = await errorOf(
      service.update('f1', { sort_order: 5 }, ...CREATOR),
    );
    expect(err).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_CONFIG_INVALID',
        errors: [
          {
            path: 'gift.conditions.rules[0].key',
            code: 'FORWARD_REFERENCE',
            params: { key: 'name_1' },
          },
        ],
      }),
    });
    expect(prisma.productCustomField.update).not.toHaveBeenCalled();
    // The same position is not a move: no re-check, the write goes through.
    await service.update('f1', { sort_order: 0 }, ...CREATOR);
    expect(prisma.productCustomField.update).toHaveBeenCalledTimes(1);
  });

  it('M5 D13: create, update, delete and reorder revalidate the storefront of the creator', async () => {
    const { service, revalidation } = setup({
      siblings: [
        {
          id: 'f1',
          name: 'name_1',
          type: 'TEXT',
          parent_id: null,
          sort_order: 0,
        },
      ],
    });
    await service.create(
      'p1',
      { name: 'n2', type: 'TEXT', is_required: false } as never,
      ...CREATOR,
    );
    await service.update('f1', { placeholder: 'x' }, ...CREATOR);
    await service.delete('f1', ...CREATOR);
    await service.reorder('p1', ['f1'], ...CREATOR);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledTimes(4);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
  });

  it('reorder refuses a forward reference (400 CONFIG_INVALID FORWARD_REFERENCE) and writes nothing', async () => {
    const { prisma, service } = setup({
      siblings: [
        {
          id: 'f1',
          name: 'name_1',
          type: 'TEXT',
          parent_id: null,
          sort_order: 0,
        },
        {
          id: 'f2',
          name: 'gift',
          type: 'TEXT',
          parent_id: null,
          sort_order: 1,
          conditions: {
            match: 'all',
            rules: [{ source: 'field', key: 'name_1', op: 'set' }],
          },
        },
      ],
    });
    const err = await errorOf(service.reorder('p1', ['f2', 'f1'], ...CREATOR));
    expect(err).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_CONFIG_INVALID',
        errors: [
          {
            path: 'gift.conditions.rules[0].key',
            code: 'FORWARD_REFERENCE',
            params: { key: 'name_1' },
          },
        ],
      }),
    });
    expect(prisma.productCustomField.updateMany).not.toHaveBeenCalled();
    await service.reorder('p1', ['f1', 'f2'], ...CREATOR);
    expect(prisma.productCustomField.updateMany).toHaveBeenCalledTimes(2);
  });
});
