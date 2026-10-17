/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { evaluatePersonalization } from '../../common/personalization/evaluator';
import type { PFieldDef } from '../../common/personalization/types';
import { PersonalizationPresetsService } from './personalization-presets.service';
import { PersonalizationLibraryService } from './personalization-library.service';
import { presetSummaries } from './presets';

// In-memory Prisma fake with a rolling-back $transaction, enough for the
// preset and library write paths.

type Row = Record<string, any>;

const CREATOR_USER = 'u-creator';
const OPTION_CONFIG = [
  { name: 'Välj antal', values: ['1 produkt', '2 produkter', '3 produkter'] },
  {
    name: 'Färg',
    values: ['Röd', 'Blå'],
    colorMap: { Röd: '#dd3333', Blå: '#3333dd' },
  },
  { name: 'Antal inskriptioner', values: ['1 Inskription', '2 Inskriptioner'] },
];

function makeFake() {
  let seq = 0;
  const id = (p: string) => `${p}-${String(++seq).padStart(4, '0')}`;
  const state = {
    products: new Map<string, Row>([
      [
        'p1',
        {
          id: 'p1',
          creator_id: 'c1',
          creator_user: CREATOR_USER,
          variant_option_config: OPTION_CONFIG,
        },
      ],
      [
        'p2',
        {
          id: 'p2',
          creator_id: 'c2',
          creator_user: 'u-other',
          variant_option_config: OPTION_CONFIG,
        },
      ],
      [
        'p-prov',
        {
          id: 'p-prov',
          creator_id: null,
          creator_user: null,
          variant_option_config: null,
        },
      ],
    ]),
    fields: [] as Row[],
    templates: [] as Row[],
  };
  const sortRows = (rows: Row[]) =>
    [...rows].sort(
      (a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1),
    );
  const prisma: Row = {
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    product: {
      findUnique: jest.fn(({ where }: Row) => {
        const p = state.products.get(where.id);
        if (!p) return Promise.resolve(null);
        return Promise.resolve({
          id: p.id,
          creator_id: p.creator_id,
          variant_option_config: p.variant_option_config,
          creator: p.creator_id
            ? {
                user_id: p.creator_user,
                store: { language_config: { primary_locale: 'sv' } },
              }
            : null,
        });
      }),
    },
    productCustomField: {
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(
          sortRows(
            state.fields.filter((f) => f.product_id === where.product_id),
          ),
        ),
      ),
      findFirst: jest.fn(({ where, include }: Row) => {
        const f = state.fields.find((x) => x.id === where.id);
        const p = f && state.products.get(f.product_id);
        if (!f || p?.creator_user !== where.product.creator.user_id)
          return Promise.resolve(null);
        return Promise.resolve(
          include?.children
            ? {
                ...f,
                children: sortRows(
                  state.fields.filter((c) => c.parent_id === f.id),
                ),
              }
            : f,
        );
      }),
      aggregate: jest.fn(({ where }: Row) => {
        const rows = state.fields.filter(
          (f) =>
            f.product_id === where.product_id &&
            (f.parent_id ?? null) === where.parent_id,
        );
        return Promise.resolve({
          _max: {
            sort_order: rows.length
              ? Math.max(...rows.map((r) => r.sort_order))
              : null,
          },
        });
      }),
      create: jest.fn(({ data }: Row) => {
        const fid = id('f');
        const { translations, ...rest } = data;
        const row: Row = {
          id: fid,
          parent_id: null,
          options: null,
          validation_rules: null,
          linked_validation: null,
          conditions: null,
          pricing: null,
          repeat: null,
          ui: null,
          placeholder: null,
          preset_key: null,
          preset_ref: null,
          ...Object.fromEntries(
            Object.entries(rest).filter(([, v]) => v !== undefined),
          ),
          translations: (translations?.create ?? []).map((t: Row) => ({
            id: id('t'),
            field_id: fid,
            ...t,
          })),
        };
        state.fields.push(row);
        return Promise.resolve(row);
      }),
      deleteMany: jest.fn(({ where }: Row) => {
        const ids = new Set<string>(where.id.in);
        const before = state.fields.length;
        state.fields = state.fields.filter(
          (f) => !ids.has(f.id) && !ids.has(f.parent_id),
        );
        return Promise.resolve({ count: before - state.fields.length });
      }),
    },
    personalizationFieldTemplate: {
      count: jest.fn(({ where }: Row) =>
        Promise.resolve(
          state.templates.filter((t) => t.store_id === where.store_id).length,
        ),
      ),
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(
          state.templates.filter((t) => t.store_id === where.store_id),
        ),
      ),
      findFirst: jest.fn(({ where }: Row) =>
        Promise.resolve(
          state.templates.find(
            (t) => t.id === where.id && t.store_id === where.store_id,
          ) ?? null,
        ),
      ),
      create: jest.fn(({ data }: Row) => {
        const row = {
          id: id('tpl'),
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        state.templates.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }: Row) => {
        const row = state.templates.find((t) => t.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
      deleteMany: jest.fn(({ where }: Row) => {
        const before = state.templates.length;
        state.templates = state.templates.filter(
          (t) => !(t.id === where.id && t.store_id === where.store_id),
        );
        return Promise.resolve({ count: before - state.templates.length });
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = JSON.stringify({
        fields: state.fields,
        templates: state.templates,
      });
      try {
        return await fn(prisma);
      } catch (err) {
        const back = JSON.parse(snapshot) as {
          fields: Row[];
          templates: Row[];
        };
        state.fields = back.fields;
        state.templates = back.templates;
        throw err;
      }
    }),
  };
  return { prisma, state };
}

const CREATOR = { userId: CREATOR_USER, role: UserRole.CREATOR };

async function errorBody(p: Promise<unknown>): Promise<Row | null> {
  try {
    await p;
  } catch (e) {
    return {
      status: (e as { getStatus(): number }).getStatus(),
      ...(e as { getResponse(): Record<string, unknown> }).getResponse(),
    };
  }
  return null;
}

function tr(row: Row, locale: string): Row {
  return row.translations.find((t: Row) => t.locale === locale);
}

describe('PersonalizationPresetsService (M4.1 §4.6)', () => {
  let fake: ReturnType<typeof makeFake>;
  let svc: PersonalizationPresetsService;
  beforeEach(() => {
    fake = makeFake();
    svc = new PersonalizationPresetsService(
      fake.prisma as unknown as PrismaService,
    );
  });

  it('lists the five presets with the dashboard param contract', () => {
    const list = presetSummaries();
    expect(list.map((p) => p.key)).toEqual([
      'names_equal_length',
      'single_name',
      'name_color_per_item',
      'engravings',
      'checkbox_group',
    ]);
    const types = new Set(list.flatMap((p) => p.params.map((x) => x.type)));
    for (const t of types) {
      expect([
        'option',
        'number',
        'boolean',
        'string',
        'string_list',
        'enum',
        'option_value_map',
        'checked_list',
        'image_map',
      ]).toContain(t);
    }
    expect(
      svc.list().find((p) => p.key === 'name_color_per_item')?.params,
    ).toContainEqual({
      key: 'count_map',
      type: 'option_value_map',
      ref: 'quantity_option',
    });
  });

  it('P1 names_equal_length: exact namez output (sv) and the evaluator accepts ❤ padding', async () => {
    const res = await svc.apply(
      'p1',
      'names_equal_length',
      { help_images: { name_1: 'https://cdn.example/left.jpg' } },
      {},
      CREATOR,
    );
    const [n1, n2, model] = res.fields;
    expect([n1.name, n2.name, model.name]).toEqual([
      'name_1',
      'name_2',
      'model_text',
    ]);
    expect(n1).toMatchObject({
      type: 'TEXT',
      is_required: true,
      validation_rules: { max_length: 11, allowed_chars: 'A-Za-z❤' },
      ui: {
        placement: 'before_variants',
        transform: 'uppercase',
        counter: true,
      },
      preset_key: 'names_equal_length',
    });
    expect(tr(n1, 'sv')).toMatchObject({
      label: 'Första texten',
      placeholder: 'KRISTOFER',
      sublabel: 'Använd texten med flest bokstäver här',
      help_text: 'Exempel:\nPATRIK\nMARKUS\nPAPPA\nCHEFEN',
      help_image_url: 'https://cdn.example/left.jpg',
      messages: {
        required: 'Ange ett värde för Första texten.',
        allowed_chars: 'Endast engelska bokstäver tillåtna (A-Z).',
      },
    });
    expect(n2).toMatchObject({
      linked_validation: {
        type: 'equal_length',
        target: 'name_1',
        fill_char: '❤',
      },
      ui: {
        counter: 'linked',
        insert_char: '❤',
        limit_to_target: true,
        transform: 'uppercase',
      },
    });
    expect(tr(n2, 'sv')).toMatchObject({
      label: 'Andra texten',
      placeholder: '❤❤KARIN❤❤',
      note: 'Antalet bokstäver i första och andra text måste matcha, eller lägg till ❤ för att göra lika.',
      messages: expect.objectContaining({
        equal_length: 'Längderna stämmer inte överens!',
      }),
    });
    expect(model).toMatchObject({
      is_required: false,
      validation_rules: { max_length: 25 },
    });
    expect(tr(model, 'sv').help_text.split('\n')).toHaveLength(9);
    expect(n1.translations.map((t: Row) => t.locale).sort()).toEqual([
      'ar',
      'de',
      'en',
      'fr',
      'sv',
      'tr',
    ]);

    const defs = fake.state.fields as unknown as PFieldDef[];
    const ctx = {
      appEnabled: true,
      variantOptions: {},
      locale: 'sv',
      primaryLocale: 'sv',
    };
    expect(
      evaluatePersonalization(
        defs,
        { [n1.id]: 'kristofer', [n2.id]: '❤karin❤' },
        ctx,
      ).errors.map((e) => e.code),
    ).toEqual(['CUSTOM_FIELD_LENGTH_MISMATCH']);
    expect(
      evaluatePersonalization(
        defs,
        { [n1.id]: 'KRISTOFER', [n2.id]: '❤❤KARIN❤❤' },
        ctx,
      ).ok,
    ).toBe(true);
  });

  it('P3 auto-applies P2 first and builds the repeater with the product palette', async () => {
    const res = await svc.apply(
      'p1',
      'name_color_per_item',
      {
        quantity_option: 'Välj antal',
        max: 5,
        count_map: { '3 produkter': 3 },
      },
      { mode: 'skip_if_exists' },
      CREATOR,
    );
    expect(res.fields.map((f) => [f.name, f.preset_key])).toEqual([
      ['custom_name_v3', 'single_name'],
      ['dnc_items', 'name_color_per_item'],
    ]);
    const rep = res.fields[1];
    expect(rep.repeat).toEqual({
      count: { option: 'Välj antal', map: { '3 produkter': 3 } },
      start_index: 2,
      max: 5,
      lead: { fields: ['custom_name_v3'], options: ['Färg'] },
    });
    expect(
      rep.children.map((c) => [c.name, c.type, c.parent_id, c.sort_order]),
    ).toEqual([
      ['color', 'COLOR_PALETTE', rep.id, 0],
      ['name', 'TEXT', rep.id, 1],
    ]);
    expect(tr(rep, 'sv').label).toBe('Artikel {i}');
    expect(tr(rep.children[0], 'sv').messages).toEqual({
      required: 'Artikel {i}: Färg måste väljas',
    });
    expect(res.fields[0].sort_order).toBeLessThan(rep.sort_order);

    // The evaluator sees 2 instances for "3 produkter" and refuses olivgrön.
    const defs = fake.state.fields as unknown as PFieldDef[];
    const r = evaluatePersonalization(
      defs,
      {
        [res.fields[0].id]: 'Åsa',
        [rep.id]: [
          { [rep.children[0].id]: 'Röd', [rep.children[1].id]: 'KARIN' },
          { [rep.children[0].id]: 'olivgrön', [rep.children[1].id]: 'Ola' },
        ],
      },
      {
        appEnabled: true,
        variantOptions: { 'Välj antal': '3 produkter', Färg: 'Blå' },
        optionConfig: OPTION_CONFIG,
        locale: 'sv',
        primaryLocale: 'sv',
      },
    );
    expect(r.errors.map((e) => [e.code, e.group_index])).toEqual([
      ['CUSTOM_FIELD_INVALID_OPTION', 3],
    ]);
  });

  it('skip_if_exists is idempotent; append conflicts with 409; nothing is half-written', async () => {
    await svc.apply(
      'p1',
      'single_name',
      {},
      { mode: 'skip_if_exists' },
      CREATOR,
    );
    const again = await svc.apply(
      'p1',
      'single_name',
      {},
      { mode: 'skip_if_exists' },
      CREATOR,
    );
    expect(again).toMatchObject({ fields: [], skipped: ['custom_name_v3'] });
    expect(fake.state.fields).toHaveLength(1);
    expect(
      await errorBody(
        svc.apply('p1', 'single_name', {}, { mode: 'append' }, CREATOR),
      ),
    ).toMatchObject({
      status: 409,
      code: 'PERSONALIZATION_PRESET_CONFLICT',
    });
    expect(fake.state.fields).toHaveLength(1);
  });

  it('replace_preset replaces only its own fields (children cascade)', async () => {
    await svc.apply(
      'p1',
      'name_color_per_item',
      { quantity_option: 'Välj antal' },
      {},
      CREATOR,
    );
    const oldRep = fake.state.fields.find((f) => f.name === 'dnc_items')!;
    const res = await svc.apply(
      'p1',
      'name_color_per_item',
      { quantity_option: 'Välj antal', max: 3 },
      { mode: 'replace_preset' },
      CREATOR,
    );
    expect(res.replaced).toBe(1);
    expect(res.fields.map((f) => f.name)).toEqual(['dnc_items']);
    expect(
      fake.state.fields.some(
        (f) => f.id === oldRep.id || f.parent_id === oldRep.id,
      ),
    ).toBe(false);
    expect(
      fake.state.fields.filter((f) => f.name === 'custom_name_v3'),
    ).toHaveLength(1);
    expect(fake.state.fields).toHaveLength(4);
  });

  it('applyInTx is atomic: a failure mid-way rolls back the whole preset', async () => {
    // The second create fails: the first field must be rolled back too.
    const writer = fake.prisma.productCustomField.create as jest.Mock;
    const real = writer.getMockImplementation()!;
    let n = 0;
    writer.mockImplementation((args: Row) => {
      if (++n === 2) throw new Error('db down');
      return real(args);
    });
    await expect(
      svc.apply('p1', 'names_equal_length', {}, {}, CREATOR),
    ).rejects.toThrow('db down');
    expect(fake.state.fields).toEqual([]);
    // applyInTx itself never opens a transaction (the importer owns it).
    fake.prisma.$transaction.mockClear();
    writer.mockImplementation(real);
    await svc.applyInTx(
      fake.prisma as never,
      'p1',
      'single_name',
      {},
      {},
      'system',
    );
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
    expect(fake.prisma.$executeRaw).toHaveBeenCalled();
  });

  it('P4 engravings: inscription i ≥ 2 has an option condition gte i', async () => {
    const res = await svc.apply('p1', 'engravings', {}, {}, CREATOR);
    expect(res.fields.map((f) => f.name)).toEqual([
      'field_1_v2',
      'field_2_v2',
      'field_3_v2',
      'field_4_v2',
    ]);
    expect(res.fields[0].conditions).toBeNull();
    expect(res.fields[2].conditions).toEqual({
      match: 'all',
      rules: [
        { source: 'option', key: 'Antal inskriptioner', op: 'gte', value: 3 },
      ],
    });
    expect(tr(res.fields[1], 'sv')).toMatchObject({
      label: 'Vänster inskription',
      sublabel: 'Upp till 15 tecken',
      messages: { required: 'Vänligen fyll i alla obligatoriska fält.' },
    });
  });

  it('P5 checkbox_group: all checked by default, label in the store locale', async () => {
    const res = await svc.apply(
      'p1',
      'checkbox_group',
      {
        label: 'Välj detaljer i designen',
        options: [
          'Student 2026',
          'Studentmössa',
          'Svensk flagga',
          'Nallebjörn',
        ],
      },
      {},
      CREATOR,
    );
    expect(res.fields[0]).toMatchObject({
      name: 'ppom_details',
      type: 'CHECKBOX_GROUP',
      is_required: false,
      options: ['Student 2026', 'Studentmössa', 'Svensk flagga', 'Nallebjörn'],
      ui: {
        default_checked: [
          'Student 2026',
          'Studentmössa',
          'Svensk flagga',
          'Nallebjörn',
        ],
        placement: 'after_variants',
      },
    });
    expect(res.fields[0].translations).toEqual([
      expect.objectContaining({
        locale: 'sv',
        label: 'Välj detaljer i designen',
      }),
    ]);
  });

  it('params: unknown key, missing required, unknown option, bad map → 400 PARAMS_INVALID', async () => {
    const body = await errorBody(
      svc.apply(
        'p1',
        'name_color_per_item',
        { quantity_option: 'Storlek', foo: 1, count_map: { '9 produkter': 9 } },
        {},
        CREATOR,
      ),
    );
    expect(body).toMatchObject({
      status: 400,
      code: 'PERSONALIZATION_PRESET_PARAMS_INVALID',
    });
    expect((body!.errors as Row[]).map((e) => `${e.path}:${e.code}`)).toEqual(
      expect.arrayContaining([
        'params.foo:UNKNOWN_KEY',
        'params.quantity_option:UNKNOWN_OPTION',
      ]),
    );
    expect(
      (
        (await errorBody(
          svc.apply(
            'p1',
            'checkbox_group',
            { options: ['a'], default_checked: ['b'] },
            {},
            CREATOR,
          ),
        ))!.errors as Row[]
      ).map((e) => `${e.path}:${e.code}`),
    ).toEqual(
      expect.arrayContaining([
        'params.label:REQUIRED',
        'params.default_checked:NOT_IN_OPTIONS',
      ]),
    );
    expect(
      await errorBody(svc.apply('p1', 'nope', {}, {}, CREATOR)),
    ).toMatchObject({
      status: 404,
      code: 'PERSONALIZATION_PRESET_UNKNOWN',
    });
  });

  it('owner gate: another creator is 403, a provider product is 400, the importer passes', async () => {
    expect(
      await errorBody(svc.apply('p2', 'single_name', {}, {}, CREATOR)),
    ).toMatchObject({
      status: 403,
      code: 'CUSTOM_FIELD_FORBIDDEN',
    });
    expect(
      await errorBody(svc.apply('p-prov', 'single_name', {}, {}, 'system')),
    ).toMatchObject({
      status: 400,
      code: 'PERSONALIZATION_CREATOR_PRODUCT_ONLY',
    });
    const res = await svc.apply(
      'p2',
      'single_name',
      {},
      { source_ref: 'woo:namez.se:product:4106' },
      'system',
    );
    expect(res.fields[0].preset_ref).toBe('woo:namez.se:product:4106');
  });
});

describe('PersonalizationLibraryService (M4.1 D13)', () => {
  let fake: ReturnType<typeof makeFake>;
  let lib: PersonalizationLibraryService;
  let presets: PersonalizationPresetsService;
  beforeEach(() => {
    fake = makeFake();
    lib = new PersonalizationLibraryService(
      fake.prisma as unknown as PrismaService,
    );
    presets = new PersonalizationPresetsService(
      fake.prisma as unknown as PrismaService,
    );
  });

  it('M5 D13: a preset apply and a library insert revalidate the storefront of the creator', async () => {
    const revalidation = {
      revalidateStoreByCreatorId: jest.fn(() => Promise.resolve()),
    };
    const presetsR = new PersonalizationPresetsService(
      fake.prisma as unknown as PrismaService,
      revalidation as never,
    );
    const libR = new PersonalizationLibraryService(
      fake.prisma as unknown as PrismaService,
      revalidation as never,
    );
    const applied = await presetsR.apply('p1', 'single_name', {}, {}, CREATOR);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
    const tpl = await libR.create('s1', CREATOR_USER, {
      name: 'Namn',
      from_field_id: applied.fields[0].id,
    } as never);
    fake.state.products.set('p3', {
      id: 'p3',
      creator_id: 'c1',
      creator_user: CREATOR_USER,
      variant_option_config: null,
    });
    await libR.insertIntoProduct('s1', CREATOR_USER, tpl.id, 'p3');
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledTimes(2);
  });

  it('saves a repeater from a field and inserts it into another product of the creator', async () => {
    const applied = await presets.apply(
      'p1',
      'name_color_per_item',
      { quantity_option: 'Välj antal', lead: false },
      {},
      CREATOR,
    );
    const rep = applied.fields[0];
    const tpl = await lib.create('s1', CREATOR_USER, {
      name: 'Namn + färg',
      from_field_id: rep.id,
    });
    expect(tpl).toMatchObject({ name: 'Namn + färg' });
    const def = tpl.definition as Row;
    expect(def.field).toMatchObject({ name: 'dnc_items', type: 'REPEATER' });
    expect(def.field).not.toHaveProperty('id');
    expect(def.children.map((c: Row) => c.name)).toEqual(['color', 'name']);
    expect(await lib.list('s1')).toHaveLength(1);

    // Name taken on p1 → 409; a fresh product of the same creator works.
    expect(
      await errorBody(lib.insertIntoProduct('s1', CREATOR_USER, tpl.id, 'p1')),
    ).toMatchObject({
      status: 409,
      code: 'CUSTOM_FIELD_NAME_TAKEN',
    });
    fake.state.products.set('p3', {
      id: 'p3',
      creator_id: 'c1',
      creator_user: CREATOR_USER,
      variant_option_config: OPTION_CONFIG,
    });
    const inserted = await lib.insertIntoProduct(
      's1',
      CREATOR_USER,
      tpl.id,
      'p3',
    );
    expect(inserted[0]).toMatchObject({
      product_id: 'p3',
      name: 'dnc_items',
      preset_key: null,
    });
    expect(inserted[0].children.map((c) => c.parent_id)).toEqual([
      inserted[0].id,
      inserted[0].id,
    ]);
  });

  it('inserting validates against the target product (unknown option → CONFIG_INVALID, rolled back)', async () => {
    const tpl = await lib.create('s1', CREATOR_USER, {
      name: 'Färgpalett',
      definition: {
        field: {
          name: 'palette',
          type: 'COLOR_PALETTE',
          is_required: true,
          ui: { palette_from_option: 'Kulör' },
          translations: [{ locale: 'sv', label: 'Färg' }],
        },
      },
    });
    const body = await errorBody(
      lib.insertIntoProduct('s1', CREATOR_USER, tpl.id, 'p1'),
    );
    expect(body).toMatchObject({
      status: 400,
      code: 'PERSONALIZATION_CONFIG_INVALID',
    });
    expect(body!.errors).toContainEqual({
      path: 'palette.ui.palette_from_option',
      code: 'UNKNOWN_OPTION',
      params: { key: 'Kulör' },
    });
    expect(fake.state.fields).toHaveLength(0);
  });

  it('definition is checked structurally', async () => {
    const body = await errorBody(
      lib.create('s1', CREATOR_USER, {
        name: 'x',
        definition: {
          field: {
            name: 'a',
            type: 'TEXT',
            translations: [{ locale: 'sv', label: 'A', bogus: 1 }],
            validation_rules: { pattern: '(' },
          },
          children: [{ name: 'b', type: 'TEXT' }],
          extra: true,
        },
      }),
    );
    expect(body).toMatchObject({
      status: 400,
      code: 'PERSONALIZATION_CONFIG_INVALID',
    });
    expect((body!.errors as Row[]).map((e) => `${e.path}:${e.code}`)).toEqual(
      expect.arrayContaining([
        'definition.extra:UNKNOWN_KEY',
        'definition.field.translations[0].bogus:UNKNOWN_KEY',
        'definition.field.validation_rules:CUSTOM_FIELD_INVALID_PATTERN',
        'definition.children:REPEATER_ONLY',
      ]),
    );
  });

  it('authorization: templates are store-scoped; foreign fields and products are refused', async () => {
    const tpl = await lib.create('s1', CREATOR_USER, {
      name: 't',
      definition: { field: { name: 'a', type: 'TEXT', translations: [] } },
    });
    expect(
      await errorBody(lib.update('s2', tpl.id, { name: 'hijack' })),
    ).toMatchObject({
      status: 404,
      code: 'PERSONALIZATION_TEMPLATE_NOT_FOUND',
    });
    expect(await errorBody(lib.remove('s2', tpl.id))).toMatchObject({
      status: 404,
    });
    expect(
      await errorBody(lib.insertIntoProduct('s2', CREATOR_USER, tpl.id, 'p1')),
    ).toMatchObject({ status: 404 });
    expect(
      await errorBody(lib.insertIntoProduct('s1', CREATOR_USER, tpl.id, 'p2')),
    ).toMatchObject({
      status: 403,
      code: 'CUSTOM_FIELD_FORBIDDEN',
    });
    await presets.apply('p2', 'single_name', {}, {}, 'system');
    const foreign = fake.state.fields.find((f) => f.product_id === 'p2')!;
    expect(
      await errorBody(
        lib.create('s1', CREATOR_USER, {
          name: 'x',
          from_field_id: foreign.id,
        }),
      ),
    ).toMatchObject({
      status: 404,
      code: 'CUSTOM_FIELD_NOT_FOUND',
    });
    expect(
      await lib.update('s1', tpl.id, { name: '  Renamed ' }),
    ).toMatchObject({ name: 'Renamed' });
    expect(await lib.remove('s1', tpl.id)).toEqual({
      id: tpl.id,
      deleted: true,
    });
    expect(await lib.list('s1')).toEqual([]);
  });

  it('caps the library at 200 templates per store', async () => {
    for (let i = 0; i < 200; i++) {
      fake.state.templates.push({
        id: `t${i}`,
        store_id: 's1',
        name: 'x',
        definition: {},
      });
    }
    expect(
      await errorBody(
        lib.create('s1', CREATOR_USER, {
          name: 'x',
          definition: { field: { name: 'a', type: 'TEXT' } },
        }),
      ),
    ).toMatchObject({ status: 400, code: 'PERSONALIZATION_TEMPLATE_LIMIT' });
  });
});

describe('PersonalizationLibraryService (M4.1 fixes)', () => {
  let fake: ReturnType<typeof makeFake>;
  let lib: PersonalizationLibraryService;
  let presets: PersonalizationPresetsService;
  beforeEach(() => {
    fake = makeFake();
    lib = new PersonalizationLibraryService(
      fake.prisma as unknown as PrismaService,
    );
    presets = new PersonalizationPresetsService(
      fake.prisma as unknown as PrismaService,
    );
  });

  it('a child saved on its own drops its sibling link, so the template can be inserted', async () => {
    const applied = await presets.apply(
      'p1',
      'name_color_per_item',
      { quantity_option: 'Välj antal', lead: false },
      {},
      CREATOR,
    );
    const rep = applied.fields[0];
    const child = fake.state.fields.find(
      (f) => f.parent_id === rep.id && f.name === 'name',
    )!;
    child.linked_validation = { type: 'equal_length', target: 'color' };
    const tpl = await lib.create('s1', CREATOR_USER, {
      name: 'Namn',
      from_field_id: child.id,
    });
    expect((tpl.definition as Row).field.linked_validation).toBeNull();
    const inserted = await lib.insertIntoProduct(
      's1',
      CREATOR_USER,
      tpl.id,
      'p1',
    );
    expect(inserted[0]).toMatchObject({ name: 'name', parent_id: null });
  });

  it('a repeater keeps its children links; a legacy id target becomes the sibling name', async () => {
    const applied = await presets.apply(
      'p1',
      'name_color_per_item',
      { quantity_option: 'Välj antal', lead: false },
      {},
      CREATOR,
    );
    const rep = applied.fields[0];
    const kids = fake.state.fields.filter((f) => f.parent_id === rep.id);
    const color = kids.find((f) => f.name === 'color')!;
    const name = kids.find((f) => f.name === 'name')!;
    name.linked_validation = {
      type: 'max_combined',
      target: color.id,
      max: 30,
    };
    const tpl = await lib.create('s1', CREATOR_USER, {
      name: 'Namn + färg',
      from_field_id: rep.id,
    });
    const children = (tpl.definition as Row).children as Row[];
    expect(children.find((c) => c.name === 'name')!.linked_validation).toEqual({
      type: 'max_combined',
      target: 'color',
      max: 30,
    });
  });

  it('the count and the insert run under a per-store advisory lock', async () => {
    await lib.create('s1', CREATOR_USER, {
      name: 'x',
      definition: { field: { name: 'a', type: 'TEXT' } },
    });
    const calls = (fake.prisma.$executeRaw as jest.Mock).mock.calls as [
      TemplateStringsArray,
      ...unknown[],
    ][];
    expect(calls.some((c) => c[1] === 'plibrary:s1')).toBe(true);
    expect(fake.prisma.$transaction).toHaveBeenCalled();
  });
});
