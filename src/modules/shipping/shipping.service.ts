import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ShippingMethodType, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateShippingProfileDto,
  CreateShippingZoneDto,
  UpdateShippingZoneDto,
  CreateShippingMethodDto,
  UpdateShippingMethodDto,
  CalculateShippingDto,
  EstimateShippingDto,
} from './dto/shipping.dto';

type OwnerType = 'provider' | 'creator';

/**
 * The profile owner a request acts as: the Provider.id / Creator.id the
 * `provider_id` / `creator_id` columns reference (never the User.id).
 */
export interface ShippingOwner {
  ownerType: OwnerType;
  ownerId: string;
}

/** One shipping method priced for a destination (API-CONTRACT-C). */
export interface QuotedShippingMethod {
  id: string;
  /** Display name resolved from translations[locale], else the default name. */
  name: string;
  type: ShippingMethodType;
  /** Major units, rounded to cents. */
  cost: number;
  estimated_days: { min: number; max: number };
  free_shipping: boolean;
}

/** What quoteForItems() returns: every method the customer may pick. */
export interface ShippingItemsQuote {
  available: boolean;
  message?: string;
  methods: QuotedShippingMethod[];
}

/** Legacy single-cost shape kept for calculateForItems() callers. */
export type ShippingCostQuote =
  | {
      available: true;
      cost: number;
      estimated_days: { min: number; max: number } | null;
      free_shipping: boolean;
    }
  | { available: false; message: string };

// A method as quoted for one profile, before profiles are merged. `matchKey`
// is what methods are matched on across profiles (the default name).
interface ProfileMethodQuote extends QuotedShippingMethod {
  matchKey: string;
}

type ZoneWithMethods = Prisma.ShippingZoneGetPayload<{
  include: { methods: true };
}>;

const SHIPPING_UNAVAILABLE = 'Shipping not available to this country';
// Name of the implicit method a zone without method rows falls back to.
const FALLBACK_METHOD_NAME = 'Standard shipping';

// Methods are always returned in their configured order.
const methodsOrderBy: Prisma.ShippingMethodOrderByWithRelationInput[] = [
  { sort_order: 'asc' },
  { created_at: 'asc' },
];
const zonesInclude = {
  zones: { include: { methods: { orderBy: methodsOrderBy } } },
} satisfies Prisma.ShippingProfileInclude;
const methodsInclude = {
  methods: { orderBy: methodsOrderBy },
} satisfies Prisma.ShippingZoneInclude;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function matchKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/** Longest display name a translated shipping method may carry. */
const MAX_TRANSLATION_LENGTH = 120;

/**
 * Keep only string values of a translations map (anything else is dropped).
 * A value longer than MAX_TRANSLATION_LENGTH is rejected rather than
 * truncated: the map is free-form JSON, so this is the only place it is
 * validated.
 */
function cleanTranslations(
  input: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  if (!input || typeof input !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [locale, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const trimmed = value.trim();
    if (trimmed.length > MAX_TRANSLATION_LENGTH) {
      throw new BadRequestException({
        code: 'SHIPPING_METHOD_TRANSLATION_TOO_LONG',
        message: `A translated name may be at most ${MAX_TRANSLATION_LENGTH} characters (${locale}).`,
      });
    }
    out[locale.trim().toLowerCase()] = trimmed;
  }
  return Object.keys(out).length ? out : null;
}

/** translations[locale] → translations[language] → default name. */
export function resolveShippingMethodName(
  method: { name: string; translations?: unknown },
  locale?: string | null,
): string {
  const map =
    method.translations && typeof method.translations === 'object'
      ? (method.translations as Record<string, unknown>)
      : null;
  if (map && locale) {
    const lower = locale.toLowerCase();
    const lang = lower.split(/[-_]/)[0];
    for (const key of [locale, lower, lang]) {
      const value = map[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return method.name;
}

/** Cheapest method; ties keep the configured order. */
function cheapestOf<T extends { cost: number }>(methods: T[]): T | null {
  let best: T | null = null;
  for (const m of methods) if (!best || m.cost < best.cost) best = m;
  return best;
}

@Injectable()
export class ShippingService {
  constructor(private prisma: PrismaService) {}

  // ── Owner resolution ──────────────────────────────────────────────────────

  /**
   * Map the authenticated user to the shipping profile owner. Profiles are
   * keyed by Provider.id / Creator.id, so the User.id must be resolved through
   * the role's profile row. Admins own nothing: `undefined` skips ownership
   * checks in the owner-scoped methods.
   */
  async resolveOwner(
    userId: string,
    role: UserRole,
  ): Promise<ShippingOwner | undefined> {
    if (role === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
        select: { id: true },
      });
      if (!provider) throw this.ownerNotFound();
      return { ownerType: 'provider', ownerId: provider.id };
    }
    if (role === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
        select: { id: true },
      });
      if (!creator) throw this.ownerNotFound();
      return { ownerType: 'creator', ownerId: creator.id };
    }
    return undefined;
  }

  /** Like resolveOwner() for routes only providers/creators may call. */
  async requireOwner(userId: string, role: UserRole): Promise<ShippingOwner> {
    const owner = await this.resolveOwner(userId, role);
    if (!owner) throw this.ownerNotFound();
    return owner;
  }

  private ownerNotFound() {
    return new NotFoundException({
      code: 'SHIPPING_OWNER_NOT_FOUND',
      message: 'Provider or creator profile not found for this user',
    });
  }

  // ── Profiles ──────────────────────────────────────────────────────────────

  async createProfile(
    ownerId: string,
    ownerType: OwnerType,
    dto: CreateShippingProfileDto,
  ) {
    const { zones, ...data } = dto;

    return this.prisma.shippingProfile.create({
      data: {
        ...data,
        ...(ownerType === 'provider'
          ? { provider_id: ownerId }
          : { creator_id: ownerId }),
        ...(zones && { zones: { create: zones.map(this.zoneCreateData) } }),
      },
      include: zonesInclude,
    });
  }

  async getProfiles(ownerId: string, ownerType: OwnerType) {
    const where =
      ownerType === 'provider'
        ? { provider_id: ownerId }
        : { creator_id: ownerId };

    return this.prisma.shippingProfile.findMany({
      where,
      include: zonesInclude,
    });
  }

  /**
   * Assert the profile belongs to the requester. No owner type means the
   * requester is an admin — only existence is checked. Foreign profiles get
   * a 404 (not 403) so profile ids are not enumerable.
   */
  private async assertProfileOwned(
    profileId: string,
    ownerId?: string,
    ownerType?: OwnerType,
  ) {
    const ownerWhere = ownerType
      ? ownerType === 'provider'
        ? { provider_id: ownerId }
        : { creator_id: ownerId }
      : {};
    const profile = await this.prisma.shippingProfile.findFirst({
      where: { id: profileId, ...ownerWhere },
    });
    if (!profile)
      throw new NotFoundException({
        code: 'SHIPPING_PROFILE_NOT_FOUND',
        message: 'Shipping profile not found',
      });
    return profile;
  }

  async deleteProfile(id: string, ownerId: string, ownerType: OwnerType) {
    const where =
      ownerType === 'provider'
        ? { provider_id: ownerId }
        : { creator_id: ownerId };
    const profile = await this.prisma.shippingProfile.findFirst({
      where: { id, ...where },
    });
    if (!profile)
      throw new NotFoundException({
        code: 'SHIPPING_PROFILE_NOT_FOUND',
        message: 'Shipping profile not found',
      });
    // Delete all zones first (methods cascade), then the profile
    await this.prisma.shippingZone.deleteMany({ where: { profile_id: id } });
    return this.prisma.shippingProfile.delete({ where: { id } });
  }

  async setDefaultProfile(id: string, ownerId: string, ownerType: OwnerType) {
    const where =
      ownerType === 'provider'
        ? { provider_id: ownerId }
        : { creator_id: ownerId };
    // Only the owner's own profile may become their default.
    await this.assertProfileOwned(id, ownerId, ownerType);
    // Clear current default, then set the new one
    await this.prisma.shippingProfile.updateMany({
      where,
      data: { is_default: false },
    });
    return this.prisma.shippingProfile.update({
      where: { id },
      data: { is_default: true },
      include: zonesInclude,
    });
  }

  // ── Zones ─────────────────────────────────────────────────────────────────

  /** Assert the zone's parent profile belongs to the requester (admin skips). */
  private async assertZoneOwned(
    zoneId: string,
    ownerId?: string,
    ownerType?: OwnerType,
  ) {
    const zone = await this.prisma.shippingZone.findUnique({
      where: { id: zoneId },
      include: { profile: { select: { provider_id: true, creator_id: true } } },
    });
    if (!zone)
      throw new NotFoundException({
        code: 'SHIPPING_ZONE_NOT_FOUND',
        message: 'Shipping zone not found',
      });
    if (ownerType) {
      const profileOwnerId =
        ownerType === 'provider'
          ? zone.profile.provider_id
          : zone.profile.creator_id;
      if (profileOwnerId !== ownerId) {
        throw new NotFoundException({
          code: 'SHIPPING_ZONE_NOT_FOUND',
          message: 'Shipping zone not found',
        });
      }
    }
    return zone;
  }

  // Nested-create payload for a zone: the legacy cost columns default to a
  // free, same-day zone when the dashboard sends methods instead.
  private zoneCreateData = (
    dto: CreateShippingZoneDto,
  ): Prisma.ShippingZoneCreateWithoutProfileInput => {
    const { methods, ...zone } = dto;
    const daysMin = zone.estimated_days_min ?? 0;
    return {
      ...zone,
      base_cost: zone.base_cost ?? 0,
      per_item_cost: zone.per_item_cost ?? 0,
      estimated_days_min: daysMin,
      estimated_days_max: Math.max(zone.estimated_days_max ?? daysMin, daysMin),
      ...(methods?.length && {
        methods: { create: methods.map((m) => this.methodCreateData(m)) },
      }),
    };
  };

  async addZone(
    profileId: string,
    dto: CreateShippingZoneDto,
    ownerId?: string,
    ownerType?: OwnerType,
  ) {
    await this.assertProfileOwned(profileId, ownerId, ownerType);
    return this.prisma.shippingZone.create({
      data: { profile_id: profileId, ...this.zoneCreateData(dto) },
      include: methodsInclude,
    });
  }

  async updateZone(
    id: string,
    dto: UpdateShippingZoneDto,
    ownerId?: string,
    ownerType?: OwnerType,
  ) {
    await this.assertZoneOwned(id, ownerId, ownerType);
    return this.prisma.shippingZone.update({
      where: { id },
      data: dto,
      include: methodsInclude,
    });
  }

  async deleteZone(id: string, ownerId?: string, ownerType?: OwnerType) {
    await this.assertZoneOwned(id, ownerId, ownerType);
    return this.prisma.shippingZone.delete({ where: { id } });
  }

  // ── Methods ───────────────────────────────────────────────────────────────

  private assertDaysRange(min?: number, max?: number) {
    if (min != null && max != null && max < min) {
      throw new BadRequestException({
        code: 'SHIPPING_METHOD_DAYS_INVALID',
        message:
          'estimated_days_max must be greater than or equal to estimated_days_min',
      });
    }
  }

  private methodCreateData(
    dto: CreateShippingMethodDto,
  ): Prisma.ShippingMethodCreateWithoutZoneInput {
    this.assertDaysRange(dto.estimated_days_min, dto.estimated_days_max);
    const translations = cleanTranslations(dto.translations);
    return {
      name: dto.name.trim(),
      translations: translations ?? Prisma.DbNull,
      type: dto.type ?? ShippingMethodType.DELIVERY,
      base_cost: dto.base_cost,
      per_item_cost: dto.per_item_cost ?? 0,
      free_threshold: dto.free_threshold ?? null,
      estimated_days_min: dto.estimated_days_min,
      estimated_days_max: dto.estimated_days_max,
      is_active: dto.is_active ?? true,
      sort_order: dto.sort_order ?? 0,
    };
  }

  /** Assert the method's zone → profile belongs to the requester (admin skips). */
  private async assertMethodOwned(
    methodId: string,
    ownerId?: string,
    ownerType?: OwnerType,
  ) {
    const method = await this.prisma.shippingMethod.findUnique({
      where: { id: methodId },
      include: {
        zone: {
          select: {
            profile: { select: { provider_id: true, creator_id: true } },
          },
        },
      },
    });
    const notFound = () =>
      new NotFoundException({
        code: 'SHIPPING_METHOD_NOT_FOUND',
        message: 'Shipping method not found',
      });
    if (!method) throw notFound();
    if (ownerType) {
      const profileOwnerId =
        ownerType === 'provider'
          ? method.zone.profile.provider_id
          : method.zone.profile.creator_id;
      if (profileOwnerId !== ownerId) throw notFound();
    }
    return method;
  }

  async addMethod(
    zoneId: string,
    dto: CreateShippingMethodDto,
    ownerId?: string,
    ownerType?: OwnerType,
  ) {
    await this.assertZoneOwned(zoneId, ownerId, ownerType);
    return this.prisma.shippingMethod.create({
      data: { zone_id: zoneId, ...this.methodCreateData(dto) },
    });
  }

  async updateMethod(
    id: string,
    dto: UpdateShippingMethodDto,
    ownerId?: string,
    ownerType?: OwnerType,
  ) {
    const existing = await this.assertMethodOwned(id, ownerId, ownerType);
    this.assertDaysRange(
      dto.estimated_days_min ?? existing.estimated_days_min,
      dto.estimated_days_max ?? existing.estimated_days_max,
    );
    const { translations, name, ...rest } = dto;
    const data: Prisma.ShippingMethodUpdateInput = { ...rest };
    if (name !== undefined) data.name = name.trim();
    if (translations !== undefined) {
      data.translations = cleanTranslations(translations) ?? Prisma.DbNull;
    }
    return this.prisma.shippingMethod.update({ where: { id }, data });
  }

  async deleteMethod(id: string, ownerId?: string, ownerType?: OwnerType) {
    await this.assertMethodOwned(id, ownerId, ownerType);
    return this.prisma.shippingMethod.delete({ where: { id } });
  }

  // ── Quotes ────────────────────────────────────────────────────────────────

  /**
   * Price every method of the zone for a destination. A zone with no method
   * rows at all is priced from its legacy cost columns as one "Standard
   * shipping" method (id `zone:<id>`), so pre-migration data keeps working.
   */
  private quoteZone(
    zone: ZoneWithMethods,
    itemCount: number,
    subtotal: number,
    locale?: string | null,
  ): ProfileMethodQuote[] {
    const price = (m: {
      base_cost: Prisma.Decimal;
      per_item_cost: Prisma.Decimal;
      free_threshold: Prisma.Decimal | null;
    }) => {
      let cost = Number(m.base_cost) + Number(m.per_item_cost) * itemCount;
      if (m.free_threshold != null && subtotal >= Number(m.free_threshold)) {
        cost = 0;
      }
      return round2(cost);
    };

    if (zone.methods.length === 0) {
      const cost = price(zone);
      return [
        {
          id: `zone:${zone.id}`,
          name: FALLBACK_METHOD_NAME,
          matchKey: matchKeyOf(FALLBACK_METHOD_NAME),
          type: ShippingMethodType.DELIVERY,
          cost,
          estimated_days: {
            min: zone.estimated_days_min,
            max: zone.estimated_days_max,
          },
          free_shipping: cost === 0,
        },
      ];
    }

    return zone.methods
      .filter((m) => m.is_active)
      .map((m) => {
        const cost = price(m);
        return {
          id: m.id,
          name: resolveShippingMethodName(m, locale),
          matchKey: matchKeyOf(m.name),
          type: m.type,
          cost,
          estimated_days: {
            min: m.estimated_days_min,
            max: m.estimated_days_max,
          },
          free_shipping: cost === 0,
        };
      });
  }

  private findZone(
    zones: ZoneWithMethods[],
    countryCode: string,
  ): ZoneWithMethods | undefined {
    const wanted = countryCode.trim().toUpperCase();
    return zones.find((z) =>
      z.countries.some((c) => c.trim().toUpperCase() === wanted),
    );
  }

  /**
   * Combine per-profile quotes (a marketplace cart spanning several
   * fulfillers) into one list, matched by method name: a method is offered
   * only when every profile has it, priced at the highest cost and the widest
   * day range across them. When nothing is common, the cheapest method of each
   * profile is merged the same way under the first profile's method, so a
   * destination every profile can ship to is never left without an option.
   */
  private mergeProfileQuotes(
    perProfile: ProfileMethodQuote[][],
  ): QuotedShippingMethod[] {
    if (perProfile.length === 0) return [];

    const merge = (
      lead: ProfileMethodQuote,
      matches: ProfileMethodQuote[],
    ): QuotedShippingMethod => {
      const cost = Math.max(...matches.map((m) => m.cost));
      return {
        id: lead.id,
        name: lead.name,
        type: lead.type,
        cost,
        estimated_days: {
          min: Math.min(...matches.map((m) => m.estimated_days.min)),
          max: Math.max(...matches.map((m) => m.estimated_days.max)),
        },
        free_shipping: cost === 0,
      };
    };

    // A single profile: its methods as quoted (merge() just strips matchKey).
    if (perProfile.length === 1) {
      return perProfile[0].map((m) => merge(m, [m]));
    }

    const [first, ...others] = perProfile;
    const common = first.filter((m) =>
      others.every((p) => p.some((x) => x.matchKey === m.matchKey)),
    );
    if (common.length > 0) {
      return common.map((m) =>
        merge(m, [
          m,
          ...others.map((p) => p.find((x) => x.matchKey === m.matchKey)!),
        ]),
      );
    }

    const cheapest = perProfile.map((p) => cheapestOf(p));
    if (cheapest.some((m) => !m)) return [];
    const [lead, ...rest] = cheapest as ProfileMethodQuote[];
    return [merge(lead, [lead, ...rest])];
  }

  /**
   * Shipping profiles the given products ship under: the product's own
   * profile, else its provider's / creator's default profile. Custom products
   * resolve through their base product.
   */
  private async resolveProfileIds(productIds: string[]): Promise<string[]> {
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        shipping_profile_id: true,
        provider_id: true,
        creator_id: true,
      },
    });

    // Also check for custom products whose underlying product might not be in the list
    const missingIds = productIds.filter(
      (pid) => !products.find((p) => p.id === pid),
    );
    if (missingIds.length > 0) {
      const customProducts = await this.prisma.customProduct.findMany({
        where: { id: { in: missingIds } },
        select: {
          product: {
            select: {
              id: true,
              shipping_profile_id: true,
              provider_id: true,
              creator_id: true,
            },
          },
        },
      });
      for (const cp of customProducts) {
        if (cp.product && !products.find((p) => p.id === cp.product.id)) {
          products.push(cp.product);
        }
      }
    }

    const profileIds = new Set<string>();
    for (const prod of products) {
      if (prod.shipping_profile_id) {
        profileIds.add(prod.shipping_profile_id);
      } else if (prod.provider_id) {
        const defaultProfile = await this.prisma.shippingProfile.findFirst({
          where: { provider_id: prod.provider_id, is_default: true },
          select: { id: true },
        });
        if (defaultProfile) profileIds.add(defaultProfile.id);
      } else if (prod.creator_id) {
        // Creator-only product: fall back to the creator's default profile.
        const defaultProfile = await this.prisma.shippingProfile.findFirst({
          where: { creator_id: prod.creator_id, is_default: true },
          select: { id: true },
        });
        if (defaultProfile) profileIds.add(defaultProfile.id);
      }
    }
    return [...profileIds];
  }

  /**
   * Every shipping method the customer may pick for these products and this
   * destination (API-CONTRACT-C). Products with no shipping profile at all
   * ship free: `available: true` with an empty `methods` list.
   */
  async quoteForItems(dto: EstimateShippingDto): Promise<ShippingItemsQuote> {
    const profileIds = await this.resolveProfileIds(dto.product_ids);
    if (profileIds.length === 0) return { available: true, methods: [] };

    const profiles = await this.prisma.shippingProfile.findMany({
      where: { id: { in: profileIds } },
      include: zonesInclude,
    });
    // Keep the resolution order so "first profile" is deterministic.
    profiles.sort(
      (a, b) => profileIds.indexOf(a.id) - profileIds.indexOf(b.id),
    );

    const perProfile: ProfileMethodQuote[][] = [];
    for (const profile of profiles) {
      const zone = this.findZone(profile.zones, dto.country_code);
      if (!zone) {
        return { available: false, message: SHIPPING_UNAVAILABLE, methods: [] };
      }
      const methods = this.quoteZone(
        zone,
        dto.item_count,
        dto.subtotal,
        dto.locale,
      );
      // A zone whose methods are all switched off ships nowhere.
      if (methods.length === 0) {
        return { available: false, message: SHIPPING_UNAVAILABLE, methods: [] };
      }
      perProfile.push(methods);
    }

    return { available: true, methods: this.mergeProfileQuotes(perProfile) };
  }

  /**
   * Back-compat wrapper: the cheapest quoted method as the single cost the
   * pre-methods API returned. Nothing new should depend on it.
   */
  async calculateForItems(
    dto: EstimateShippingDto,
  ): Promise<ShippingCostQuote> {
    const quote = await this.quoteForItems(dto);
    if (!quote.available) {
      return {
        available: false,
        message: quote.message ?? SHIPPING_UNAVAILABLE,
      };
    }
    const cheapest = cheapestOf(quote.methods);
    if (!cheapest) {
      return {
        available: true,
        cost: 0,
        free_shipping: true,
        estimated_days: null,
      };
    }
    return {
      available: true,
      cost: cheapest.cost,
      estimated_days: cheapest.estimated_days,
      free_shipping: cheapest.cost === 0,
    };
  }

  /** `POST /shipping/estimate`: the full quote plus the legacy cheapest cost. */
  async estimate(dto: EstimateShippingDto) {
    const quote = await this.quoteForItems(dto);
    if (!quote.available) return quote;
    const cheapest = cheapestOf(quote.methods);
    return {
      ...quote,
      cost: cheapest?.cost ?? 0,
      estimated_days: cheapest?.estimated_days ?? null,
      free_shipping: (cheapest?.cost ?? 0) === 0,
    };
  }

  /** `POST /shipping/calculate`: one profile, the legacy shape plus `methods`. */
  async calculate(dto: CalculateShippingDto) {
    const profile = await this.prisma.shippingProfile.findUnique({
      where: { id: dto.profile_id },
      include: zonesInclude,
    });

    if (!profile)
      throw new NotFoundException({
        code: 'SHIPPING_PROFILE_NOT_FOUND',
        message: 'Shipping profile not found',
      });

    const zone = this.findZone(profile.zones, dto.country_code);
    if (!zone) {
      return { available: false, message: SHIPPING_UNAVAILABLE };
    }

    const methods = this.mergeProfileQuotes([
      this.quoteZone(zone, dto.item_count, dto.subtotal, dto.locale),
    ]);
    const cheapest = cheapestOf(methods);
    if (!cheapest) {
      return { available: false, message: SHIPPING_UNAVAILABLE };
    }

    return {
      available: true,
      zone_name: zone.name,
      cost: cheapest.cost,
      estimated_days: cheapest.estimated_days,
      free_shipping: cheapest.cost === 0,
      methods,
    };
  }
}
