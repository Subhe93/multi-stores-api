import { SetMetadata } from '@nestjs/common';
import type { StoreAppKey } from '../store-apps/store-apps.registry';

export const REQUIRE_APP_KEY = 'require_app';

/**
 * Marks a route as belonging to a store app: RequireAppGuard answers 403
 * STORE_APP_NOT_ENABLED unless the resolved store has `key` in effect.
 */
export const RequireApp = (key: StoreAppKey) =>
  SetMetadata(REQUIRE_APP_KEY, key);
