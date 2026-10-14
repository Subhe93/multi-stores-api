import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CreateAddressDto,
} from './dto/create-customer.dto';
import { normalizeOrgNumber, validateOrgNumber } from '../b2b/org-number.util';
import { normalizeVatNumber } from '../b2b/vat-number.util';

/**
 * b2b app: company defaults are prefill, not a legal snapshot, so they are
 * normalised (canonical org-number form when it validates for the country,
 * VAT upper-cased without spaces) but never rejected here; the order path
 * validates. Blank strings clear the field. Keys absent from the body stay
 * absent so a partial update leaves the other columns alone.
 */
function normalizeCompanyFields<
  T extends {
    org_number?: string | null;
    vat_number?: string | null;
    company_name?: string | null;
  },
>(dto: T, country?: string | null): T {
  const out = { ...dto };
  // Null and blank both clear the column (stored as null).
  const orNull = (value: string) => (value ? value : null);
  if (typeof dto.company_name === 'string') {
    out.company_name = orNull(dto.company_name.trim().replace(/\s+/g, ' '));
  }
  if (typeof dto.org_number === 'string') {
    out.org_number = orNull(normalizeOrgNumber(country, dto.org_number));
  }
  if (typeof dto.vat_number === 'string') {
    out.vat_number = orNull(normalizeVatNumber(dto.vat_number));
  }
  return out;
}

/**
 * Org number on the customer's own defaults (PUT /customers/me), which carry
 * no country: use the default address's country when there is one; else
 * store the Swedish pretty form when the value validates as a Swedish number
 * (the platform's primary market, and what the address path would store);
 * else the generic treatment (trimmed). Never rejects.
 */
export function normalizeProfileOrgNumber(
  raw: string,
  defaultCountry: string | null | undefined,
): string {
  if (defaultCountry) return normalizeOrgNumber(defaultCountry, raw);
  const se = validateOrgNumber('SE', raw, { strictCountries: ['SE'] });
  return se.ok ? se.normalized : normalizeOrgNumber(null, raw);
}

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateCustomerDto) {
    return this.prisma.customer.create({
      data: { user_id: userId, ...dto },
    });
  }

  async findByUserId(userId: string) {
    const customer = await this.ensureCustomer(userId);
    return this.prisma.customer.findUnique({
      where: { id: customer.id },
      include: { addresses: true },
    });
  }

  async update(userId: string, dto: UpdateCustomerDto) {
    const data = normalizeCompanyFields(dto, null);
    if (typeof dto.org_number === 'string' && data.org_number) {
      // The customer's defaults carry no country: borrow the default
      // address's (see normalizeProfileOrgNumber).
      const address = await this.prisma.address.findFirst({
        where: { customer: { user_id: userId }, is_default: true },
        select: { country_code: true },
      });
      data.org_number = normalizeProfileOrgNumber(
        dto.org_number,
        address?.country_code,
      );
    }
    return this.prisma.customer.update({
      where: { user_id: userId },
      data,
    });
  }

  // Ensure customer record exists (auto-create for users registered before this was added)
  private async ensureCustomer(userId: string) {
    let customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      customer = await this.prisma.customer.create({
        data: {
          user_id: userId,
          first_name: user?.email?.split('@')[0] || '',
          last_name: '',
        },
      });
    }
    return customer;
  }

  // Addresses
  async addAddress(userId: string, dto: CreateAddressDto) {
    const customer = await this.ensureCustomer(userId);

    return this.prisma.address.create({
      data: {
        customer_id: customer.id,
        ...normalizeCompanyFields(dto, dto.country_code),
      },
    });
  }

  async getAddresses(userId: string) {
    const customer = await this.ensureCustomer(userId);

    return this.prisma.address.findMany({
      where: { customer_id: customer.id },
      orderBy: { is_default: 'desc' },
    });
  }

  async deleteAddress(userId: string, addressId: string) {
    const customer = await this.ensureCustomer(userId);

    return this.prisma.address.delete({
      where: { id: addressId, customer_id: customer.id },
    });
  }
}
