import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateShippingProfileDto,
  CreateShippingZoneDto,
  CalculateShippingDto,
  EstimateShippingDto,
} from './dto/shipping.dto';

@Injectable()
export class ShippingService {
  constructor(private prisma: PrismaService) {}

  async createProfile(ownerId: string, ownerType: 'provider' | 'creator', dto: CreateShippingProfileDto) {
    const { zones, ...data } = dto;

    return this.prisma.shippingProfile.create({
      data: {
        ...data,
        ...(ownerType === 'provider' ? { provider_id: ownerId } : { creator_id: ownerId }),
        ...(zones && { zones: { create: zones } }),
      },
      include: { zones: true },
    });
  }

  async getProfiles(ownerId: string, ownerType: 'provider' | 'creator') {
    const where = ownerType === 'provider'
      ? { provider_id: ownerId }
      : { creator_id: ownerId };

    return this.prisma.shippingProfile.findMany({
      where,
      include: { zones: true },
    });
  }

  async addZone(profileId: string, dto: CreateShippingZoneDto) {
    return this.prisma.shippingZone.create({
      data: { profile_id: profileId, ...dto },
    });
  }

  async updateZone(id: string, dto: Partial<CreateShippingZoneDto>) {
    return this.prisma.shippingZone.update({
      where: { id },
      data: dto,
    });
  }

  async deleteProfile(id: string, ownerId: string, ownerType: 'provider' | 'creator') {
    const where = ownerType === 'provider' ? { provider_id: ownerId } : { creator_id: ownerId };
    const profile = await this.prisma.shippingProfile.findFirst({ where: { id, ...where } });
    if (!profile) throw new NotFoundException({ code: 'SHIPPING_PROFILE_NOT_FOUND', message: 'Shipping profile not found' });
    // Delete all zones first, then the profile
    await this.prisma.shippingZone.deleteMany({ where: { profile_id: id } });
    return this.prisma.shippingProfile.delete({ where: { id } });
  }

  async setDefaultProfile(id: string, ownerId: string, ownerType: 'provider' | 'creator') {
    const where = ownerType === 'provider' ? { provider_id: ownerId } : { creator_id: ownerId };
    // Clear current default, then set the new one
    await this.prisma.shippingProfile.updateMany({ where, data: { is_default: false } });
    return this.prisma.shippingProfile.update({ where: { id }, data: { is_default: true }, include: { zones: true } });
  }

  async deleteZone(id: string) {
    return this.prisma.shippingZone.delete({ where: { id } });
  }

  async calculate(dto: CalculateShippingDto) {
    const profile = await this.prisma.shippingProfile.findUnique({
      where: { id: dto.profile_id },
      include: { zones: true },
    });

    if (!profile) throw new NotFoundException({ code: 'SHIPPING_PROFILE_NOT_FOUND', message: 'Shipping profile not found' });

    // إيجاد المنطقة التي تحتوي على دولة العميل
    const zone = profile.zones.find((z) =>
      z.countries.includes(dto.country_code),
    );

    if (!zone) {
      return { available: false, message: 'Shipping not available to this country' };
    }

    // حساب التكلفة
    let cost = Number(zone.base_cost) + Number(zone.per_item_cost) * dto.item_count;

    // شحن مجاني فوق حد معين
    if (zone.free_threshold && dto.subtotal >= Number(zone.free_threshold)) {
      cost = 0;
    }

    return {
      available: true,
      zone_name: zone.name,
      cost: Math.round(cost * 100) / 100,
      estimated_days: {
        min: zone.estimated_days_min,
        max: zone.estimated_days_max,
      },
      free_shipping: cost === 0,
    };
  }

  async calculateForItems(dto: EstimateShippingDto) {
    // Resolve shipping profiles for all product IDs
    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.product_ids } },
      select: { id: true, shipping_profile_id: true, provider_id: true, creator_id: true },
    });

    // Also check for custom products whose underlying product might not be in the list
    const missingIds = dto.product_ids.filter(
      (pid) => !products.find((p) => p.id === pid),
    );
    if (missingIds.length > 0) {
      const customProducts = await this.prisma.customProduct.findMany({
        where: { id: { in: missingIds } },
        select: { product: { select: { id: true, shipping_profile_id: true, provider_id: true, creator_id: true } } },
      });
      for (const cp of customProducts) {
        if (cp.product && !products.find((p) => p.id === cp.product.id)) {
          products.push(cp.product);
        }
      }
    }

    // Resolve profile IDs (with provider default fallback)
    const profileIds = new Set<string>();

    for (const prod of products) {
      if (prod.shipping_profile_id) {
        profileIds.add(prod.shipping_profile_id);
      } else if (prod.provider_id) {
        const defaultProfile = await this.prisma.shippingProfile.findFirst({
          where: { provider_id: prod.provider_id, is_default: true },
        });
        if (defaultProfile) profileIds.add(defaultProfile.id);
      } else if (prod.creator_id) {
        // Creator-only product: fall back to the creator's default profile.
        const defaultProfile = await this.prisma.shippingProfile.findFirst({
          where: { creator_id: prod.creator_id, is_default: true },
        });
        if (defaultProfile) profileIds.add(defaultProfile.id);
      }
    }

    // No profiles found → free shipping
    if (profileIds.size === 0) {
      return { available: true, cost: 0, free_shipping: true, estimated_days: null };
    }

    // Calculate for each unique profile
    let maxCost = 0;
    let minDays = Infinity;
    let maxDays = 0;

    for (const profileId of profileIds) {
      const result = await this.calculate({
        profile_id: profileId,
        country_code: dto.country_code,
        item_count: dto.item_count,
        subtotal: dto.subtotal,
      });

      if (!(result as any).available) {
        return { available: false, message: (result as any).message || 'Shipping not available to this country' };
      }

      const r = result as { cost: number; estimated_days: { min: number; max: number } };
      if (r.cost > maxCost) maxCost = r.cost;
      if (r.estimated_days.min < minDays) minDays = r.estimated_days.min;
      if (r.estimated_days.max > maxDays) maxDays = r.estimated_days.max;
    }

    return {
      available: true,
      cost: maxCost,
      estimated_days: { min: minDays, max: maxDays },
      free_shipping: maxCost === 0,
    };
  }
}
