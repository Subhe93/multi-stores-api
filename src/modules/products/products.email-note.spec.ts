import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { UserRole } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  OWNER_PRODUCT_TRANSLATIONS,
  ProductsService,
  normalizeEmailNote,
  redactProductForNonOwner,
} from './products.service';
import { ProductTranslationDto } from './dto/product.dto';
import {
  PRISMA_GLOBAL_OMIT,
  type PrismaService,
} from '../../prisma/prisma.service';

// Headless booking E2.1: ProductTranslation.email_note (the per-product order
// confirmation note) is owner-only. It is omitted globally by PrismaService;
// only the mail include and the owner product read / write / duplicate opt
// in. Storefront, cart, page builder, bundles and payments never name the
// column, so their `translations: true` reads cannot carry it.

type Row = Record<string, unknown>;

describe('email_note privacy (global omit)', () => {
  it('PrismaService omits ProductTranslation.email_note by default', () => {
    expect(PRISMA_GLOBAL_OMIT.productTranslation).toEqual({ email_note: true });
  });

  /** Non-spec source files under src/ that mention `email_note`. */
  function filesNaming(): string[] {
    const root = join(__dirname, '..', '..');
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          name.endsWith('.ts') &&
          !name.endsWith('.spec.ts') &&
          readFileSync(p, 'utf8').includes('email_note')
        )
          out.push(relative(root, p).split(sep).join('/'));
      }
    };
    walk(root);
    return out.sort();
  }

  it('only the owner product paths and the order mail opt in to the column', () => {
    // A new reader must be a deliberate, reviewed addition to this list;
    // storefront / cart / pages / bundles / payments must never appear.
    expect(filesNaming()).toEqual([
      'modules/mail/mail.service.ts',
      'modules/mail/order-mail.helpers.ts',
      'modules/products/dto/product.dto.ts',
      'modules/products/products.service.ts',
      'prisma/prisma.service.ts',
    ]);
  });

  it('the owner include opts in explicitly', () => {
    expect(OWNER_PRODUCT_TRANSLATIONS).toEqual({
      omit: { email_note: false },
    });
  });

  it('non-owner product reads never carry the note', () => {
    const out = redactProductForNonOwner({
      id: 'p1',
      cost_price: 10,
      external_ref: 'x',
      translations: [
        { locale: 'sv', title: 'T', email_note: 'Ta med glasögon' },
      ],
    }) as { translations: Row[] };
    expect(out.translations).toEqual([{ locale: 'sv', title: 'T' }]);
    expect(JSON.stringify(out)).not.toContain('email_note');
  });
});

describe('ProductsService.findById email_note', () => {
  // The caller is creator c1. Owner: c1's own product. Non-owner: a
  // PUBLISHED provider product the creator may browse to import (any other
  // non-owner read is a 404 since the supplier-privacy fix).
  function setup(owns: boolean) {
    const findUnique = jest.fn((_args: { include: Row }) =>
      Promise.resolve({
        id: 'p1',
        cost_price: 10,
        external_ref: null,
        ...(owns
          ? { provider_id: null, creator_id: 'c1', status: 'DRAFT' }
          : { provider_id: 'pr1', creator_id: null, status: 'PUBLISHED' }),
        translations: [{ locale: 'sv', title: 'T', email_note: 'Ta med' }],
        videos: [],
        stories: [],
      }),
    );
    const svc = new ProductsService(
      {
        product: { findUnique },
        creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
        provider: { findUnique: jest.fn(() => Promise.resolve(null)) },
      } as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, findUnique };
  }

  it('owner read opts in and returns the note', async () => {
    const { svc, findUnique } = setup(true);
    const p = (await svc.findById('p1', 'u', UserRole.CREATOR)) as {
      translations: Row[];
    };
    expect(findUnique.mock.calls[0][0].include.translations).toEqual({
      omit: { email_note: false },
    });
    expect(p.translations[0].email_note).toBe('Ta med');
  });

  it('non-owner read strips it', async () => {
    const { svc } = setup(false);
    const p = await svc.findById('p1', 'u', UserRole.CREATOR);
    expect(JSON.stringify(p)).not.toContain('email_note');
  });
});

describe('ProductTranslationDto email_note', () => {
  const errs = async (email_note: unknown) =>
    (
      await validate(
        plainToInstance(ProductTranslationDto, {
          locale: 'sv',
          title: 'T',
          description: 'd',
          slug: 's',
          email_note,
        }),
      )
    ).map((e) => e.property);

  it('accepts up to 500 characters, null and absent', async () => {
    expect(await errs('x'.repeat(500))).toEqual([]);
    expect(await errs(null)).toEqual([]);
    expect(await errs(undefined)).toEqual([]);
  });

  it('refuses 501 characters and non-strings', async () => {
    expect(await errs('x'.repeat(501))).toEqual(['email_note']);
    expect(await errs(5)).toEqual(['email_note']);
  });

  it('normalizes: trimmed, empty = null', () => {
    expect(normalizeEmailNote('  Ta med  ')).toBe('Ta med');
    expect(normalizeEmailNote('   ')).toBeNull();
    expect(normalizeEmailNote('')).toBeNull();
    expect(normalizeEmailNote(null)).toBeNull();
  });
});

function updateSetup(
  stored: {
    locale: string;
    short_description: string | null;
    email_note: string | null;
  }[],
) {
  const createMany = jest.fn((_args: { data: Row[] }) => undefined);
  const findMany = jest.fn(() => Promise.resolve(stored));
  const prisma = {
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          creator_id: 'c1',
          variant_option_config: null,
        }),
      ),
      update: jest.fn(),
    },
    productTranslation: {
      findMany,
      findFirst: jest.fn(() => Promise.resolve(null)),
      deleteMany: jest.fn(),
      createMany,
    },
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
    customProductTranslation: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.checkOwnership = jest.fn(() => Promise.resolve());
  internals.assertTaxClassAllowed = jest.fn(() => Promise.resolve());
  internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
  internals.syncVariantsAndImages = jest.fn(() => Promise.resolve());
  internals.revalidateForCreator = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  const written = () => (createMany.mock.calls[0][0] as { data: Row[] }).data;
  return { svc, findMany, written };
}

const tr = (locale: string, extra: Row = {}) => ({
  locale,
  title: `T-${locale}`,
  description: 'd',
  slug: `s-${locale}`,
  ...extra,
});

describe('ProductsService.update email_note carry-over', () => {
  it('undefined keeps the stored note per locale (older clients keep it)', async () => {
    const { svc, written } = updateSetup([
      { locale: 'sv', short_description: null, email_note: 'Ta med glasögon' },
      { locale: 'en', short_description: null, email_note: null },
    ]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [tr('sv'), tr('en'), tr('de')],
    });
    expect(written().map((r) => [r.locale, r.email_note])).toEqual([
      ['sv', 'Ta med glasögon'],
      ['en', null],
      ['de', null],
    ]);
  });

  it('a sent value replaces it (trimmed); null or empty clears it', async () => {
    const { svc, written } = updateSetup([
      { locale: 'sv', short_description: null, email_note: 'Old' },
      { locale: 'en', short_description: null, email_note: 'Old' },
      { locale: 'de', short_description: null, email_note: 'Old' },
    ]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        tr('sv', { email_note: '  New  ' }),
        tr('en', { email_note: null }),
        tr('de', { email_note: '   ' }),
      ],
    });
    expect(written().map((r) => [r.locale, r.email_note])).toEqual([
      ['sv', 'New'],
      ['en', null],
      ['de', null],
    ]);
  });

  it('the stored-rows read selects the note (one read)', async () => {
    const { svc, findMany } = updateSetup([]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [tr('sv')],
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(
      (findMany.mock.calls[0] as unknown as [{ select: Row }])[0].select,
    ).toMatchObject({ email_note: true, short_description: true });
  });
});

describe('ProductsService.duplicate email_note', () => {
  it('opts in to the note and copies it', async () => {
    const trCreateMany = jest.fn((_args: { data: Row[] }) => undefined);
    const tx = {
      product: { create: jest.fn(() => Promise.resolve({ id: 'new' })) },
      productTranslation: {
        createMany: trCreateMany,
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      customProductTranslation: {
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      productTag: { createMany: jest.fn() },
      productAttribute: { createMany: jest.fn() },
      productVariant: { create: jest.fn(() => Promise.resolve({ id: 'v' })) },
      productImage: { createMany: jest.fn() },
      productFaq: { create: jest.fn() },
      productCustomField: { create: jest.fn() },
    };
    const findUnique = jest.fn((_args: { include: Row }) =>
      Promise.resolve({
        id: 'src',
        translations: [
          {
            locale: 'sv',
            title: 'Riskettan',
            description: 'd',
            slug: 'riskettan',
            meta_title: null,
            meta_desc: null,
            short_description: null,
            email_note: 'Ta med glasögon',
          },
        ],
        images: [],
        attributes: [],
        variants: [],
        tags: [],
        faqs: [],
        custom_fields: [],
        shipping_profile_id: null,
        variant_option_config: null,
      }),
    );
    const prisma = {
      product: { findUnique },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      store: { findUnique: jest.fn(() => Promise.resolve(null)) },
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

    await svc.duplicate('src', 'u', UserRole.ADMIN);

    expect(findUnique.mock.calls[0][0].include.translations).toEqual({
      omit: { email_note: false },
    });
    expect(trCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      locale: 'sv',
      email_note: 'Ta med glasögon',
    });
  });
});
