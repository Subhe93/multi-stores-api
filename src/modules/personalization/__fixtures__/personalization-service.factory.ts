import { PrismaService } from '../../../prisma/prisma.service';
import { StoreAppsService } from '../../store-apps/store-apps.service';
import { PersonalizationCoreService } from '../../../common/personalization/personalization-core.service';
import { CustomerUploadsService } from '../../customer-uploads/customer-uploads.service';
import { ShippingService } from '../../shipping/shipping.service';
import { MarketsContextService } from '../../markets/markets-context.service';
import { MarketPricingService } from '../../markets/market-pricing.service';
import { PersonalizationService } from '../personalization.service';

/**
 * The M4.0 core on a Prisma double, with a `CustomerUploadsService` on the
 * same double (M5 A16: `CartService` and `OrdersService` no longer build a
 * fallback core themselves).
 */
export function buildPersonalizationCore(prisma: unknown): {
  core: PersonalizationCoreService;
  uploads: CustomerUploadsService;
} {
  const uploads = new CustomerUploadsService(prisma as PrismaService);
  const core = new PersonalizationCoreService(prisma as PrismaService, uploads);
  return { core, uploads };
}

/** `[core, uploads]` for the positional `OrdersService` constructor. */
export function personalizationCoreArgs(
  prisma: unknown,
): readonly [PersonalizationCoreService, CustomerUploadsService] {
  const { core, uploads } = buildPersonalizationCore(prisma);
  return [core, uploads] as const;
}

/**
 * Spec factory for `PersonalizationService` (M5 A16): the runtime
 * collaborators are required by the constructor, so a spec that only cares
 * about one of them passes that one and gets inert doubles for the rest
 * (no free-shipping threshold, no market, the core built on the same
 * Prisma double).
 */
export function buildPersonalizationService(deps: {
  prisma: unknown;
  storeApps: unknown;
  core?: PersonalizationCoreService;
  shipping?: unknown;
  markets?: unknown;
  marketPricing?: MarketPricingService;
}): PersonalizationService {
  const prisma = deps.prisma as PrismaService;
  const core =
    deps.core ??
    new PersonalizationCoreService(prisma, {} as CustomerUploadsService);
  const shipping = (deps.shipping ?? {
    freeThresholdFor: () => Promise.resolve(null),
  }) as ShippingService;
  const markets = (deps.markets ?? {
    resolve: () => Promise.resolve(null),
  }) as MarketsContextService;
  return new PersonalizationService(
    prisma,
    deps.storeApps as StoreAppsService,
    core,
    shipping,
    markets,
    deps.marketPricing,
  );
}
