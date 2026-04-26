import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CreateAddressDto,
} from './dto/create-customer.dto';

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
    return this.prisma.customer.update({
      where: { user_id: userId },
      data: dto,
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
      data: { customer_id: customer.id, ...dto },
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
