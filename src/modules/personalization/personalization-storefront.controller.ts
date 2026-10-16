import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RequireApp } from '../../common/decorators';
import {
  RequireAppGuard,
  type RequestWithAppStore,
} from '../../common/guards/require-app.guard';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { ValidatePersonalizationDto } from './dto/validate-personalization.dto';
import {
  PersonalizationService,
  type PersonalizationValidateResult,
} from './personalization.service';

/**
 * Public route of the personalization app (M4.1 §4.4, D14): guests check a
 * line before it enters their local cart. Gated by the app (403
 * STORE_APP_NOT_ENABLED via the store slug) and throttled per IP like the
 * b2b VAT check.
 */
@Controller('storefront')
@UseGuards(RequireAppGuard)
@RequireApp('personalization')
export class PersonalizationStorefrontController {
  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly personalization: PersonalizationService,
  ) {}

  @Post(':slug/personalization/validate')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async validate(
    @Param('slug') slug: string,
    @Body() dto: ValidatePersonalizationDto,
    @Req() req?: RequestWithAppStore,
  ): Promise<PersonalizationValidateResult> {
    // RequireAppGuard already resolved the store from the slug.
    const storeId =
      req?.appStoreId ?? (await this.storeApps.storeIdBySlug(slug));
    if (!storeId) {
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return this.personalization.validateForStorefront(storeId, dto);
  }
}
