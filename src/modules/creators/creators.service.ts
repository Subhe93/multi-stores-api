import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCreatorDto, UpdateCreatorDto } from './dto/create-creator.dto';

@Injectable()
export class CreatorsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateCreatorDto) {
    return this.prisma.creator.create({
      data: {
        user_id: userId,
        ...dto,
      },
    });
  }

  async findByUserId(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException('Creator profile not found');
    return creator;
  }

  async findById(id: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { id },
      include: { user: { select: { email: true, status: true } } },
    });
    if (!creator) throw new NotFoundException('Creator not found');
    return creator;
  }

  async update(userId: string, dto: UpdateCreatorDto) {
    // avatar lives on both User (canonical for /auth/me) and Creator — keep
    // them in sync so the header/sidebar reflects the new image immediately.
    const { avatar_url, ...creatorFields } = dto;
    return this.prisma.$transaction(async (tx) => {
      if (avatar_url !== undefined) {
        await tx.user.update({
          where: { id: userId },
          data: { avatar_url },
        });
      }
      return tx.creator.update({
        where: { user_id: userId },
        data: { ...creatorFields, ...(avatar_url !== undefined ? { avatar_url } : {}) },
      });
    });
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.creator.findMany({
        skip,
        take: limit,
        include: { user: { select: { email: true, status: true } } },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.creator.count(),
    ]);
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async verify(id: string) {
    return this.prisma.creator.update({
      where: { id },
      data: { verified: true },
    });
  }
}
