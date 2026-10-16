import { Injectable, OnModuleInit } from '@nestjs/common';
import { CustomerUploadsService } from '../customer-uploads/customer-uploads.service';
import type { CustomerUploadRetentionPolicy } from '../customer-uploads/customer-uploads.types';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { parsePersonalizationSettings } from './personalization-settings';

/**
 * Customer-upload retention of the personalization app (C23, U12): while the
 * app is enabled for a store, uploads are kept `retention_days` (default 60)
 * after the order; otherwise the policy has no opinion (`undefined`), so the
 * platform default applies. Registered once at module init.
 */
@Injectable()
export class PersonalizationRetentionPolicy
  implements CustomerUploadRetentionPolicy, OnModuleInit
{
  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly customerUploads: CustomerUploadsService,
  ) {}

  onModuleInit(): void {
    this.customerUploads.registerRetentionPolicy(this);
  }

  async retentionDays(storeId: string): Promise<number | undefined> {
    const settings = await this.storeApps.getSettings(
      storeId,
      'personalization',
    );
    if (settings === null) return undefined;
    return parsePersonalizationSettings(settings).retention_days;
  }
}
