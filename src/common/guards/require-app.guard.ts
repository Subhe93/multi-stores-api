import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_APP_KEY, type RequestUser } from '../decorators';
import type { StoreAppKey } from '../store-apps/store-apps.registry';
import { StoreAppsService } from '../../modules/store-apps/store-apps.service';

interface AppRequest {
  params?: Record<string, string | undefined>;
  user?: RequestUser;
  /** Set by RequireAppGuard: the store the app was checked for. */
  appStoreId?: string;
}

/** A request that passed RequireAppGuard (the resolved store id is attached). */
export type RequestWithAppStore = AppRequest;

/**
 * Gate of routes decorated with @RequireApp(key). The store is resolved from
 * the route params (`storeId`, then `slug`) and otherwise from the
 * authenticated creator, so the guard must run after AuthGuard('jwt') on
 * creator routes. Routes without the decorator pass through.
 *
 * `params.slug` is interpreted as a STORE slug: only decorate storefront-style
 * routes (`/storefront/:slug/...`) or routes with an explicit `:storeId` /
 * creator JWT. The `legal` and `categories` controllers also use `:slug` for
 * other entities and must not carry @RequireApp.
 */
@Injectable()
export class RequireAppGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly storeApps: StoreAppsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<StoreAppKey | undefined>(
      REQUIRE_APP_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!key) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const storeId = await this.resolveStoreId(request);
    if (!storeId || !(await this.storeApps.isEnabled(storeId, key))) {
      throw new ForbiddenException({
        code: 'STORE_APP_NOT_ENABLED',
        message: `The "${key}" app is not enabled for this store.`,
      });
    }
    // Handlers reuse the resolved store instead of resolving it again.
    request.appStoreId = storeId;
    return true;
  }

  private async resolveStoreId(request: AppRequest): Promise<string | null> {
    const params = request.params ?? {};
    if (params.storeId) return params.storeId;
    if (params.slug) return this.storeApps.storeIdBySlug(params.slug);
    if (request.user?.id) return this.storeApps.storeIdByUser(request.user.id);
    return null;
  }
}
