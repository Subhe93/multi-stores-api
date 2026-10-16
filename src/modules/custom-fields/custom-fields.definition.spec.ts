import { ConflictException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { CustomFieldsService } from './custom-fields.service';
import { PrismaService } from '../../prisma/prisma.service';

// M4.0 §3.2 / §6.2: merchant rules are checked at save time (coded 400s),
// `null` clears a rule, links point at a sibling field name, names are unique
// per product, and delete no longer fails once orders reference the field.

type Sibling = { id: string; name: string; linked_validation?: unknown };

function makePrisma(
  opts: { clash?: boolean; deleteError?: unknown; siblings?: Sibling[] } = {},
) {
  const siblings: Sibling[] = opts.siblings ?? [
    { id: 'f2', name: 'name_2', linked_validation: null },
  ];
  const prisma = {
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'p1', provider: null, creator: null }),
      ),
    },
    productCustomField: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'f1', product_id: 'p1', name: 'name_1' }),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve(opts.clash ? { id: 'other' } : null),
      ),
      findMany: jest.fn(() => Promise.resolve(siblings)),
      create: jest.fn((args: unknown) => Promise.resolve(args)),
      update: jest.fn((args: unknown) => Promise.resolve(args)),
      delete: jest.fn(() =>
        opts.deleteError
          ? Promise.reject(opts.deleteError as Error)
          : Promise.resolve({ id: 'f1' }),
      ),
    },
    customFieldTranslation: { deleteMany: jest.fn() },
    // Per-product field lock (advisory lock) and the store app settings.
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    storeApp: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    $transaction: jest.fn(
      (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
    ),
  };
  return prisma;
}

const ADMIN = UserRole.ADMIN;

function svc(prisma: ReturnType<typeof makePrisma>) {
  return new CustomFieldsService(prisma as unknown as PrismaService);
}

async function code(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return ((e as { getResponse(): { code?: string } }).getResponse() ?? {})
      .code;
  }
  return null;
}

type UpdateArg = { data: Record<string, unknown> };

describe('CustomFieldsService definitions (M4.0)', () => {
  it('null clears validation_rules and linked_validation (DB NULL)', async () => {
    const prisma = makePrisma();
    await svc(prisma).update(
      'f1',
      { validation_rules: null, linked_validation: null },
      'u',
      ADMIN,
    );
    const arg = prisma.productCustomField.update.mock.calls[0][0] as UpdateArg;
    expect(arg.data.validation_rules).toBe(Prisma.DbNull);
    expect(arg.data.linked_validation).toBe(Prisma.DbNull);
  });

  it('rules not sent are left alone', async () => {
    const prisma = makePrisma();
    await svc(prisma).update('f1', { is_required: true }, 'u', ADMIN);
    const arg = prisma.productCustomField.update.mock.calls[0][0] as UpdateArg;
    expect(arg.data).toEqual({ is_required: true });
  });

  it('bad pattern / allowed_chars / unknown rule are coded 400s', async () => {
    const s = svc(makePrisma());
    expect(
      await code(
        s.update('f1', { validation_rules: { pattern: '^(abc$' } }, 'u', ADMIN),
      ),
    ).toBe('CUSTOM_FIELD_INVALID_PATTERN');
    for (const body of ['a-z]|.*[', '[']) {
      expect(
        await code(
          s.update(
            'f1',
            { validation_rules: { allowed_chars: body } },
            'u',
            ADMIN,
          ),
        ),
      ).toBe('CUSTOM_FIELD_INVALID_ALLOWED_CHARS');
    }
    expect(
      await code(s.update('f1', { validation_rules: { min: 1 } }, 'u', ADMIN)),
    ).toBe('CUSTOM_FIELD_INVALID_RULES');
  });

  it('valid rules are stored normalized (presets, numeric strings)', async () => {
    const prisma = makePrisma();
    await svc(prisma).update(
      'f1',
      {
        validation_rules: {
          max_length: '11',
          min_length: null,
          allowed_chars: 'a-zA-Z❤\\s',
          pattern: '',
        },
      },
      'u',
      ADMIN,
    );
    const arg = prisma.productCustomField.update.mock.calls[0][0] as UpdateArg;
    expect(arg.data.validation_rules).toEqual({
      max_length: 11,
      allowed_chars: 'a-zA-Z❤\\s',
    });
  });

  it('links: legacy target_field_id stored as target; self and max-less max_combined refused', async () => {
    const prisma = makePrisma();
    const s = svc(prisma);
    await s.update(
      'f1',
      {
        linked_validation: {
          type: 'equal_length',
          target_field_id: 'name_2',
          fill_char: '❤',
        },
      },
      'u',
      ADMIN,
    );
    const arg = prisma.productCustomField.update.mock.calls[0][0] as UpdateArg;
    expect(arg.data.linked_validation).toEqual({
      type: 'equal_length',
      target: 'name_2',
      fill_char: '❤',
    });
    expect(
      await code(
        s.update(
          'f1',
          { linked_validation: { type: 'equal_length', target: 'name_1' } },
          'u',
          ADMIN,
        ),
      ),
    ).toBe('CUSTOM_FIELD_INVALID_LINK');
    expect(
      await code(
        s.update(
          'f1',
          { linked_validation: { type: 'max_combined', target: 'name_2' } },
          'u',
          ADMIN,
        ),
      ),
    ).toBe('CUSTOM_FIELD_INVALID_LINK');
    await s.update(
      'f1',
      {
        linked_validation: { type: 'max_combined', target: 'name_2', max: 20 },
      },
      'u',
      ADMIN,
    );
  });

  it('duplicate name on the product → 409 CUSTOM_FIELD_NAME_TAKEN', async () => {
    const s = svc(makePrisma({ clash: true }));
    expect(
      await code(
        s.create('p1', { name: 'name_1', type: 'TEXT' } as never, 'u', ADMIN),
      ),
    ).toBe('CUSTOM_FIELD_NAME_TAKEN');
    expect(await code(s.update('f1', { name: 'name_2' }, 'u', ADMIN))).toBe(
      'CUSTOM_FIELD_NAME_TAKEN',
    );
  });

  it('renaming to its own name does not check uniqueness', async () => {
    const prisma = makePrisma({ clash: true });
    await svc(prisma).update('f1', { name: 'name_1' }, 'u', ADMIN);
    expect(prisma.productCustomField.findFirst).not.toHaveBeenCalled();
  });

  it('an unsafe pattern is a 400 with params.reason = unsafe', async () => {
    const err = await svc(makePrisma())
      .update(
        'f1',
        { validation_rules: { pattern: '^([A-Za-z]+ ?)+$' } },
        'u',
        ADMIN,
      )
      .catch((e: { getResponse(): unknown }) => e.getResponse());
    expect(err).toMatchObject({
      code: 'CUSTOM_FIELD_INVALID_PATTERN',
      params: { reason: 'unsafe' },
    });
    const long = await svc(makePrisma())
      .update(
        'f1',
        { validation_rules: { pattern: 'a'.repeat(201) } },
        'u',
        ADMIN,
      )
      .catch((e: { getResponse(): unknown }) => e.getResponse());
    expect(long).toMatchObject({ params: { reason: 'too_long', max: 200 } });
  });

  it('fill_char must be exactly one character', async () => {
    const s = svc(makePrisma());
    for (const fill of ['ab', '❤️❤']) {
      expect(
        await code(
          s.update(
            'f1',
            {
              linked_validation: {
                type: 'equal_length',
                target: 'name_2',
                fill_char: fill,
              },
            },
            'u',
            ADMIN,
          ),
        ),
      ).toBe('CUSTOM_FIELD_INVALID_LINK');
    }
    // Heart + VS16 counts as one character.
    await s.update(
      'f1',
      {
        linked_validation: {
          type: 'equal_length',
          target: 'name_2',
          fill_char: '❤️',
        },
      },
      'u',
      ADMIN,
    );
  });

  it('the link target must be a sibling name (or a legacy sibling id)', async () => {
    const prisma = makePrisma();
    const s = svc(prisma);
    const link = (target: string) => ({
      linked_validation: { type: 'max_combined', target, max: 20 },
    });
    expect(await code(s.update('f1', link('missing'), 'u', ADMIN))).toBe(
      'CUSTOM_FIELD_INVALID_LINK',
    );
    expect(
      await code(
        s.create(
          'p1',
          { name: 'name_3', type: 'TEXT', ...link('nope') } as never,
          'u',
          ADMIN,
        ),
      ),
    ).toBe('CUSTOM_FIELD_INVALID_LINK');
    await s.update('f1', link('name_2'), 'u', ADMIN);
    await s.update('f1', link('f2'), 'u', ADMIN);
    expect(prisma.productCustomField.findMany).toHaveBeenCalledWith({
      // C16: siblings = same product and same parent (top level here).
      where: { product_id: 'p1', parent_id: null, id: { not: 'f1' } },
      select: { id: true, name: true },
    });
  });

  it('renaming a field moves sibling links to the new name in the same transaction', async () => {
    const prisma = makePrisma({
      siblings: [
        {
          id: 'f2',
          name: 'name_2',
          linked_validation: { type: 'equal_length', target: 'name_1' },
        },
        {
          id: 'f3',
          name: 'name_3',
          linked_validation: { type: 'max_combined', target: 'name_2', max: 9 },
        },
        // Legacy link by id: unaffected by a rename.
        {
          id: 'f4',
          name: 'name_4',
          linked_validation: { type: 'equal_length', target_field_id: 'f1' },
        },
      ],
    });
    await svc(prisma).update('f1', { name: 'first_name' }, 'u', ADMIN);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const calls = prisma.productCustomField.update.mock.calls.map(
      (c) => c[0] as { where: { id: string }; data: Record<string, unknown> },
    );
    expect(calls.map((c) => c.where.id)).toEqual(['f1', 'f2']);
    expect(calls[1].data.linked_validation).toEqual({
      type: 'equal_length',
      target: 'first_name',
    });
  });

  it('delete succeeds; a remaining FK error (P2003) becomes 409 CUSTOM_FIELD_IN_USE', async () => {
    await expect(svc(makePrisma()).delete('f1', 'u', ADMIN)).resolves.toEqual({
      id: 'f1',
    });
    const err = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: 'x',
    });
    const p = svc(makePrisma({ deleteError: err })).delete('f1', 'u', ADMIN);
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    expect(await code(p)).toBe('CUSTOM_FIELD_IN_USE');
  });
});
