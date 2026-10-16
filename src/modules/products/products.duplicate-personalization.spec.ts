import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';

// M4.1 X20: duplicate() copies the personalization columns of fields and
// translations and remaps a REPEATER child's parent_id to the cloned
// parent; fields without M4.1 data are copied exactly as before.

type Row = Record<string, unknown>;

const T = (locale: string, extra: Row = {}) => ({
  locale,
  label: `L-${locale}`,
  placeholder: null,
  option_labels: null,
  display_label: null,
  sublabel: null,
  note: null,
  help_text: null,
  help_image_url: null,
  messages: null,
  ...extra,
});

const FIELD = (id: string, extra: Row = {}) => ({
  id,
  name: id,
  type: 'TEXT',
  is_required: false,
  placeholder: null,
  options: null,
  validation_rules: null,
  linked_validation: null,
  sort_order: 0,
  parent_id: null,
  conditions: null,
  pricing: null,
  repeat: null,
  ui: null,
  preset_key: null,
  preset_ref: null,
  translations: [T('sv')],
  ...extra,
});

function setup(customFields: Row[]) {
  let n = 0;
  const created: Row[] = [];
  const tx = {
    product: { create: jest.fn(() => Promise.resolve({ id: 'new-product' })) },
    productTranslation: { createMany: jest.fn() },
    productTag: { createMany: jest.fn() },
    productAttribute: { createMany: jest.fn() },
    productVariant: { create: jest.fn() },
    productImage: { createMany: jest.fn() },
    productFaq: { create: jest.fn() },
    productCustomField: {
      create: jest.fn((args: { data: Row }) => {
        created.push(args.data);
        return Promise.resolve({ id: `clone-${++n}` });
      }),
    },
  };
  const prisma = {
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'src',
          translations: [],
          images: [],
          attributes: [],
          variants: [],
          tags: [],
          faqs: [],
          custom_fields: customFields,
          shipping_profile_id: null,
          variant_option_config: null,
        }),
      ),
    },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.checkOwnership = jest.fn(() => Promise.resolve());
  internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  return { svc, created };
}

describe('ProductsService.duplicate personalization (M4.1 X20)', () => {
  it('copies M4.1 columns and remaps parent_id (children listed before their parent)', async () => {
    const { svc, created } = setup([
      // Source order by sort_order: a child may come before its parent.
      FIELD('child', {
        parent_id: 'rep',
        type: 'COLOR_PALETTE',
        sort_order: 0,
        ui: { palette_from_option: 'Färg' },
      }),
      FIELD('rep', {
        type: 'REPEATER',
        sort_order: 1,
        repeat: { count: { option: 'Välj antal' }, start_index: 2, max: 5 },
        ui: { validation_summary: true },
        preset_key: 'name_color_per_item',
        preset_ref: 'woo:namez.se:product:4106',
        conditions: {
          match: 'all',
          rules: [{ source: 'option', key: 'Välj antal', op: 'gte', value: 2 }],
        },
        pricing: { mode: 'per_item', amount: 10 },
        translations: [
          T('sv', {
            label: 'Artikel {i}',
            display_label: 'Artikel',
            sublabel: 's',
            note: 'n',
            help_text: 'h',
            help_image_url: 'https://cdn.example/h.jpg',
            messages: { required: 'Artikel {i}: Färg måste väljas' },
          }),
        ],
      }),
      FIELD('orphan', { parent_id: 'missing-parent' }),
    ]);
    await svc.duplicate('src', 'u', UserRole.ADMIN);

    expect(created.map((c) => c.name)).toEqual(['rep', 'child']);
    expect(created[0]).toMatchObject({
      product_id: 'new-product',
      repeat: { count: { option: 'Välj antal' }, start_index: 2, max: 5 },
      ui: { validation_summary: true },
      conditions: {
        match: 'all',
        rules: [{ source: 'option', key: 'Välj antal', op: 'gte', value: 2 }],
      },
      pricing: { mode: 'per_item', amount: 10 },
      preset_key: 'name_color_per_item',
      sort_order: 1,
    });
    expect(created[0]).not.toHaveProperty('preset_ref');
    expect(created[0]).not.toHaveProperty('parent_id');
    expect(
      (created[0].translations as { create: Row[] }).create[0],
    ).toMatchObject({
      label: 'Artikel {i}',
      display_label: 'Artikel',
      sublabel: 's',
      note: 'n',
      help_text: 'h',
      help_image_url: 'https://cdn.example/h.jpg',
      messages: { required: 'Artikel {i}: Färg måste väljas' },
    });
    expect(created[1]).toMatchObject({
      parent_id: 'clone-1',
      type: 'COLOR_PALETTE',
      ui: { palette_from_option: 'Färg' },
    });
  });

  it('a field without M4.1 data is copied with exactly the pre-M4.1 keys', async () => {
    const { svc, created } = setup([
      FIELD('plain', { translations: [T('sv'), T('en')] }),
    ]);
    await svc.duplicate('src', 'u', UserRole.ADMIN);
    expect(Object.keys(created[0]).sort()).toEqual(
      [
        'product_id',
        'name',
        'type',
        'is_required',
        'placeholder',
        'options',
        'validation_rules',
        'linked_validation',
        'sort_order',
        'translations',
      ].sort(),
    );
    expect((created[0].translations as { create: Row[] }).create).toEqual([
      { locale: 'sv', label: 'L-sv', placeholder: null, option_labels: null },
      { locale: 'en', label: 'L-en', placeholder: null, option_labels: null },
    ]);
  });
});
