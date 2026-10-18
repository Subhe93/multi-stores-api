import type { StoreAppKey } from './store-apps.registry';
import { validateB2bSettings } from '../../modules/b2b/b2b-settings';
import { validateInvoiceSettings } from '../../modules/invoices/invoice-settings';
import { validatePersonalizationSettings } from '../../modules/personalization/personalization-settings';
import { validateProductionSettings } from '../../modules/production/production-settings';
import { validateDesignerSettings } from '../../modules/designer/designer-settings';
import { validateFeedsSettings } from '../../modules/feeds/feeds-settings';

// Per-app settings validators run by StoreAppsService.updateSettings before
// the settings object is stored. Pure functions only (no injection), so the
// store-apps service stays unaware of what each app keeps in `settings`.
// An app without an entry accepts any object, as every app did before.
const SETTINGS_VALIDATORS: Partial<
  Record<StoreAppKey, (settings: unknown) => { ok: boolean; errors: string[] }>
> = {
  b2b: validateB2bSettings,
  invoices: validateInvoiceSettings,
  personalization: validatePersonalizationSettings,
  production: validateProductionSettings,
  designer: validateDesignerSettings,
  feeds: validateFeedsSettings,
};

/** Problems with `settings` for `key`; empty = accepted. */
export function validateStoreAppSettings(
  key: StoreAppKey,
  settings: unknown,
): string[] {
  const validator = SETTINGS_VALIDATORS[key];
  return validator ? validator(settings).errors : [];
}
