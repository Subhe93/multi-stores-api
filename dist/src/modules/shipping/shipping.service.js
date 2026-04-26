"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShippingService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let ShippingService = class ShippingService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createProfile(ownerId, ownerType, dto) {
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
    async getProfiles(ownerId, ownerType) {
        const where = ownerType === 'provider'
            ? { provider_id: ownerId }
            : { creator_id: ownerId };
        return this.prisma.shippingProfile.findMany({
            where,
            include: { zones: true },
        });
    }
    async addZone(profileId, dto) {
        return this.prisma.shippingZone.create({
            data: { profile_id: profileId, ...dto },
        });
    }
    async updateZone(id, dto) {
        return this.prisma.shippingZone.update({
            where: { id },
            data: dto,
        });
    }
    async deleteProfile(id, ownerId, ownerType) {
        const where = ownerType === 'provider' ? { provider_id: ownerId } : { creator_id: ownerId };
        const profile = await this.prisma.shippingProfile.findFirst({ where: { id, ...where } });
        if (!profile)
            throw new common_1.NotFoundException('Shipping profile not found');
        await this.prisma.shippingZone.deleteMany({ where: { profile_id: id } });
        return this.prisma.shippingProfile.delete({ where: { id } });
    }
    async setDefaultProfile(id, ownerId, ownerType) {
        const where = ownerType === 'provider' ? { provider_id: ownerId } : { creator_id: ownerId };
        await this.prisma.shippingProfile.updateMany({ where, data: { is_default: false } });
        return this.prisma.shippingProfile.update({ where: { id }, data: { is_default: true }, include: { zones: true } });
    }
    async deleteZone(id) {
        return this.prisma.shippingZone.delete({ where: { id } });
    }
    async calculate(dto) {
        const profile = await this.prisma.shippingProfile.findUnique({
            where: { id: dto.profile_id },
            include: { zones: true },
        });
        if (!profile)
            throw new common_1.NotFoundException('Shipping profile not found');
        const zone = profile.zones.find((z) => z.countries.includes(dto.country_code));
        if (!zone) {
            return { available: false, message: 'Shipping not available to this country' };
        }
        let cost = Number(zone.base_cost) + Number(zone.per_item_cost) * dto.item_count;
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
    async calculateForItems(dto) {
        const products = await this.prisma.product.findMany({
            where: { id: { in: dto.product_ids } },
            select: { id: true, shipping_profile_id: true, provider_id: true },
        });
        const missingIds = dto.product_ids.filter((pid) => !products.find((p) => p.id === pid));
        if (missingIds.length > 0) {
            const customProducts = await this.prisma.customProduct.findMany({
                where: { id: { in: missingIds } },
                select: { product: { select: { id: true, shipping_profile_id: true, provider_id: true } } },
            });
            for (const cp of customProducts) {
                if (cp.product && !products.find((p) => p.id === cp.product.id)) {
                    products.push(cp.product);
                }
            }
        }
        const profileIds = new Set();
        for (const prod of products) {
            if (prod.shipping_profile_id) {
                profileIds.add(prod.shipping_profile_id);
            }
            else if (prod.provider_id) {
                const defaultProfile = await this.prisma.shippingProfile.findFirst({
                    where: { provider_id: prod.provider_id, is_default: true },
                });
                if (defaultProfile)
                    profileIds.add(defaultProfile.id);
            }
        }
        if (profileIds.size === 0) {
            return { available: true, cost: 0, free_shipping: true, estimated_days: null };
        }
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
            if (!result.available) {
                return { available: false, message: result.message || 'Shipping not available to this country' };
            }
            const r = result;
            if (r.cost > maxCost)
                maxCost = r.cost;
            if (r.estimated_days.min < minDays)
                minDays = r.estimated_days.min;
            if (r.estimated_days.max > maxDays)
                maxDays = r.estimated_days.max;
        }
        return {
            available: true,
            cost: maxCost,
            estimated_days: { min: minDays, max: maxDays },
            free_shipping: maxCost === 0,
        };
    }
};
exports.ShippingService = ShippingService;
exports.ShippingService = ShippingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ShippingService);
//# sourceMappingURL=shipping.service.js.map