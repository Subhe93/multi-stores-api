import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  CreateCreatorDto,
  OnboardingProfileDto,
  UpdateCreatorDto,
} from './dto/create-creator.dto';

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
    if (!creator)
      throw new NotFoundException({
        code: 'CREATOR_PROFILE_NOT_FOUND',
        message: 'Creator profile not found',
      });
    return creator;
  }

  async findById(id: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { id },
      include: { user: { select: { email: true, status: true } } },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });
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
        data: {
          ...creatorFields,
          ...(avatar_url !== undefined ? { avatar_url } : {}),
        },
      });
    });
  }

  /**
   * Merges the survey answers into `Creator.onboarding_profile` and stamps
   * `completed_at`. Only the given keys change; `account_kind` (sign-up
   * card) survives untouched. Returns the stored profile.
   */
  async updateOnboardingProfile(
    userId: string,
    dto: OnboardingProfileDto,
    now = new Date(),
  ) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true, onboarding_profile: true },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'CREATOR_PROFILE_NOT_FOUND',
        message: 'Creator profile not found',
      });
    const current =
      creator.onboarding_profile &&
      typeof creator.onboarding_profile === 'object' &&
      !Array.isArray(creator.onboarding_profile)
        ? (creator.onboarding_profile as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = {
      ...current,
      ...(dto.stage !== undefined ? { stage: dto.stage } : {}),
      ...(dto.sells !== undefined ? { sells: dto.sells } : {}),
      ...(dto.country !== undefined
        ? { country: dto.country.toUpperCase() }
        : {}),
      completed_at: now.toISOString(),
    };
    const updated = await this.prisma.creator.update({
      where: { id: creator.id },
      data: { onboarding_profile: merged as Prisma.InputJsonObject },
      select: { onboarding_profile: true },
    });
    return { onboarding_profile: updated.onboarding_profile };
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
