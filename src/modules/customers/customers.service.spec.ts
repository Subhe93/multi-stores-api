import {
  CustomersService,
  normalizeProfileOrgNumber,
} from './customers.service';
import { PrismaService } from '../../prisma/prisma.service';

// PUT /customers/me: the org number has no country of its own, so it borrows
// the default address's; without one a valid Swedish number gets the SE
// pretty form (matching the address path) and anything else is stored
// trimmed. Never rejects.

describe('normalizeProfileOrgNumber', () => {
  it('uses the default address country when given', () => {
    expect(normalizeProfileOrgNumber('5560360793', 'SE')).toBe('556036-0793');
    expect(normalizeProfileOrgNumber('5560360793', 'DE')).toBe('5560360793');
    expect(normalizeProfileOrgNumber('0737546-2', 'FI')).toBe('0737546-2');
  });

  it('falls back to the SE form for a valid Swedish number', () => {
    expect(normalizeProfileOrgNumber('5560360793', null)).toBe('556036-0793');
    expect(normalizeProfileOrgNumber('165560360793', undefined)).toBe(
      '556036-0793',
    );
  });

  it('otherwise keeps the trimmed input, never rejecting', () => {
    expect(normalizeProfileOrgNumber(' 559123-4567 ', null)).toBe(
      '559123-4567',
    );
    expect(normalizeProfileOrgNumber('HRB  1', null)).toBe('HRB 1');
    expect(normalizeProfileOrgNumber('!', null)).toBe('!');
  });
});

describe('CustomersService.update', () => {
  function build(defaultCountry: string | null) {
    const prisma = {
      address: {
        findFirst: jest.fn(() =>
          Promise.resolve(
            defaultCountry ? { country_code: defaultCountry } : null,
          ),
        ),
      },
      customer: {
        update: jest.fn((args: unknown) => Promise.resolve(args)),
      },
    };
    const service = new CustomersService(prisma as unknown as PrismaService);
    return { service, prisma };
  }

  const dataOf = (prisma: ReturnType<typeof build>['prisma']) =>
    (prisma.customer.update.mock.calls[0] as unknown as [{ data: unknown }])[0]
      .data;

  it('stores the SE pretty form without a default address', async () => {
    const { service, prisma } = build(null);
    await service.update('u1', { org_number: '5560360793' });
    expect(prisma.address.findFirst).toHaveBeenCalledWith({
      where: { customer: { user_id: 'u1' }, is_default: true },
      select: { country_code: true },
    });
    expect(dataOf(prisma)).toEqual({ org_number: '556036-0793' });
  });

  it("uses the default address's country", async () => {
    const { service, prisma } = build('DK');
    await service.update('u1', { org_number: '5560360793' });
    expect(dataOf(prisma)).toEqual({ org_number: '5560360793' });
  });

  it('skips the lookup when the org number is absent or blank', async () => {
    const { service, prisma } = build('SE');
    await service.update('u1', { org_number: '  ', company_name: ' A  B ' });
    expect(prisma.address.findFirst).not.toHaveBeenCalled();
    expect(dataOf(prisma)).toEqual({ org_number: null, company_name: 'A B' });
  });
});
