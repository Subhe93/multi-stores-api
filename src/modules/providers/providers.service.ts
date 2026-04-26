import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProviderDto, UpdateProviderDto } from './dto/create-provider.dto';

@Injectable()
export class ProvidersService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateProviderDto) {
    return this.prisma.provider.create({
      data: {
        user_id: userId,
        ...dto,
      },
    });
  }

  async findByUserId(userId: string) {
    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
    });
    if (!provider) throw new NotFoundException('Provider profile not found');
    return provider;
  }

  async findById(id: string) {
    const provider = await this.prisma.provider.findUnique({
      where: { id },
      include: { user: { select: { email: true, status: true } } },
    });
    if (!provider) throw new NotFoundException('Provider not found');
    return provider;
  }

  async update(userId: string, dto: UpdateProviderDto) {
    return this.prisma.provider.update({
      where: { user_id: userId },
      data: dto,
    });
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.provider.findMany({
        skip,
        take: limit,
        include: { user: { select: { email: true, status: true } } },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.provider.count(),
    ]);
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async verify(id: string) {
    return this.prisma.provider.update({
      where: { id },
      data: { verified: true },
    });
  }
}
