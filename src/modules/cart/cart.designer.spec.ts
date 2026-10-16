import { BadRequestException } from '@nestjs/common';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import type { DesignerCartService } from '../designer/designer-cart.service';

// M4.2 WP4: designer lines in the server cart (C29 step 2, C11): the design
// is validated + claimed, field values are dropped, the token is never
// stored, the same design merges, and app-off / unlinked products behave
// exactly as before.

const DESIGN = '99999999-9999-4999-8999-999999999999';

type Row = Record<string, unknown> & { id: string; quantity: number };

const FIELDS = [
  {
    id: 'f1',
    product_id: 'p1',
    name: 'namn',
    type: 'TEXT',
    is_required: true,
    options: null,
    validation_rules: null,
    linked_validation: null,
    sort_order: 0,
    preset_key: 'npp_fallback',
    translations: [{ locale: 'sv', label: 'Namn' }],
  },
];

function makePrisma(fields: unknown[]) {
  const rows: Row[] = [];
  let n = 0;
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      k === 'id'
        ? typeof v === 'string'
          ? r.id === v
          : r.id !== (v as { not: string }).not
        : (r[k] ?? null) === v,
    );
  return {
    rows,
    customer: { findUnique: jest.fn(() => Promise.resolve({ id: 'cust1' })) },
    cart: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cart1', customer_id: 'cust1' }),
      ),
    },
    productCustomField: { findMany: jest.fn(() => Promise.resolve(fields)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    cartItem: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((r) => matches(r, where))),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `r${++n}`, quantity: 1, ...data } as Row;
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
  };
}

function designerStub(mode: 'design' | 'none' | 'required') {
  return {
    resolveCartLine: jest.fn((line: { design_id?: string }) => {
      if (mode === 'required') {
        return Promise.reject(
          new BadRequestException({ code: 'DESIGNER_DESIGN_REQUIRED' }),
        );
      }
      return Promise.resolve(
        mode === 'design' && line.design_id
          ? { design: { id: line.design_id } }
          : null,
      );
    }),
    ensureProof: jest.fn(),
  };
}

function build(fields: unknown[], designer?: unknown) {
  const prisma = makePrisma(fields);
  const service = new CartService(
    prisma as unknown as PrismaService,
    {} as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    {} as B2bService,
    undefined,
    undefined,
    designer as DesignerCartService | undefined,
  );
  const internals = service as unknown as Record<string, jest.Mock>;
  jest.spyOn(service, 'getCart').mockResolvedValue({} as never);
  internals.assertAvailableInMarket = jest.fn(() => Promise.resolve());
  return { service, prisma };
}

const add = (service: CartService, body: Record<string, unknown>) =>
  service.addItem(
    'u1',
    { product_id: 'p1', quantity: 1, ...body } as never,
    'sv',
  );

describe('CartService designer lines (M4.2 WP4)', () => {
  it('stores design_id, drops field values and the token; the required field is not checked', async () => {
    const designer = designerStub('design');
    const { service, prisma } = build(FIELDS, designer);
    await add(service, {
      design_id: DESIGN,
      design_token: 'secret',
      custom_fields: { f1: 'Anna' },
    });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toEqual({
      id: 'r1',
      quantity: 1,
      cart_id: 'cart1',
      product_id: 'p1',
      design_id: DESIGN,
    });
    expect(designer.resolveCartLine).toHaveBeenCalledWith(
      expect.objectContaining({ design_id: DESIGN, design_token: 'secret' }),
      'p1',
      'cust1',
    );
    expect(designer.ensureProof).toHaveBeenCalledWith(DESIGN);
  });

  it('the same design merges; another design is another line; a plain line never merges into it', async () => {
    const { service, prisma } = build([], designerStub('design'));
    await add(service, { design_id: DESIGN });
    await add(service, { design_id: DESIGN });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].quantity).toBe(2);
    await add(service, { design_id: '99999999-9999-4999-8999-000000000000' });
    expect(prisma.rows).toHaveLength(2);
    // After the designer is switched off for the product: a plain add.
    const off = build([], designerStub('none'));
    off.prisma.rows.push({
      id: 'd1',
      cart_id: 'cart1',
      product_id: 'p1',
      quantity: 1,
      design_id: DESIGN,
    });
    await add(off.service, {});
    expect(off.prisma.rows).toHaveLength(2);
    expect(off.prisma.rows[1]).not.toHaveProperty('design_id');
  });

  it('a linked product without design is refused (rule 2)', async () => {
    const { service, prisma } = build(FIELDS, designerStub('required'));
    await expect(
      add(service, { custom_fields: { f1: 'Anna' } }),
    ).rejects.toMatchObject({
      response: { code: 'DESIGNER_DESIGN_REQUIRED' },
    });
    expect(prisma.rows).toHaveLength(0);
  });

  it('G0: not a designer line → same row, same query as without the service', async () => {
    const withSvc = build(FIELDS, designerStub('none'));
    const without = build(FIELDS);
    for (const b of [withSvc, without]) {
      await add(b.service, { custom_fields: { f1: 'Anna' } });
    }
    expect(withSvc.prisma.rows).toEqual(without.prisma.rows);
    expect(withSvc.prisma.cartItem.findMany.mock.calls).toEqual(
      without.prisma.cartItem.findMany.mock.calls,
    );
  });

  it('without the service a sent design_id / token is never stored', async () => {
    const { service, prisma } = build([]);
    await add(service, { design_id: DESIGN, design_token: 't' });
    expect(prisma.rows[0]).not.toHaveProperty('design_id');
    expect(prisma.rows[0]).not.toHaveProperty('design_token');
  });

  it('custom_fields updates are ignored on designer rows', async () => {
    const { service, prisma } = build(FIELDS, designerStub('design'));
    await add(service, { design_id: DESIGN });
    await service.updateItem('u1', 'r1', {
      custom_fields: { f1: 'X' },
    } as never);
    expect(prisma.rows[0]).not.toHaveProperty('custom_fields');
    expect(prisma.productCustomField.findMany).toHaveBeenCalledTimes(1);
  });
});
