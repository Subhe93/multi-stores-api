import type { CustomerUploadsService } from '../customer-uploads/customer-uploads.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import { PersonalizationRetentionPolicy } from './personalization-retention.policy';

// C23 / U12: while the app is enabled, customer uploads are kept
// `retention_days` (default 60); otherwise the policy has no opinion.

function setup(
  settingsByStore: Record<string, Record<string, unknown> | null>,
) {
  const storeApps = {
    getSettings: jest.fn((storeId: string, key: string) =>
      Promise.resolve(
        key === 'personalization' ? (settingsByStore[storeId] ?? null) : null,
      ),
    ),
  };
  const uploads = { registerRetentionPolicy: jest.fn() };
  const policy = new PersonalizationRetentionPolicy(
    storeApps as unknown as StoreAppsService,
    uploads as unknown as CustomerUploadsService,
  );
  return { policy, uploads, storeApps };
}

describe('PersonalizationRetentionPolicy', () => {
  it('registers itself with the customer-upload registry on init', () => {
    const { policy, uploads } = setup({});
    policy.onModuleInit();
    expect(uploads.registerRetentionPolicy).toHaveBeenCalledWith(policy);
  });

  it('app enabled: the setting, default 60; invalid values fall back to 60', async () => {
    const { policy, storeApps } = setup({
      on: { retention_days: 30 },
      defaults: {},
      bad: { retention_days: 3 },
    });
    await expect(policy.retentionDays('on')).resolves.toBe(30);
    await expect(policy.retentionDays('defaults')).resolves.toBe(60);
    await expect(policy.retentionDays('bad')).resolves.toBe(60);
    expect(storeApps.getSettings).toHaveBeenCalledWith('on', 'personalization');
  });

  it('app off (no settings in effect): no opinion', async () => {
    const { policy } = setup({ off: null });
    await expect(policy.retentionDays('off')).resolves.toBeUndefined();
  });
});
