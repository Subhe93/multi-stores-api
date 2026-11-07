import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles, VerifiedAccount } from '../../../common/decorators';
import type { RequestUser } from '../../../common/decorators/current-user.decorator';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { UserThrottlerGuard } from '../../../common/guards/user-throttler.guard';
import { VerifiedAccountGuard } from '../../../common/guards/verified-account.guard';
import { PaymentKeysGuardService } from '../../security/payment-keys-guard.service';
import { ReqMeta, type RequestMeta } from '../../security/request-meta';
import { RemoveOwnKeyDto, SaveOwnKeyDto } from './dto/own-key.dto';
import { OwnKeyService } from './own-key.service';

/** 10 Stripe-touching calls per minute per signed-in user. */
const KEY_THROTTLE = { default: { limit: 10, ttl: 60000 } };

// Owner's own Stripe account (INDEPENDENT stores). Responses carry status
// only — never key material (key_last4 at most).
@Controller('stores/my/payments/stripe-key')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class OwnKeyController {
  constructor(
    private readonly ownKey: OwnKeyService,
    private readonly paymentKeys: PaymentKeysGuardService,
  ) {}

  @Get()
  get(@CurrentUser('id') userId: string) {
    return this.ownKey.getMine(userId);
  }

  // Re-auth (password + 2FA) before anything touches Stripe.
  @Put()
  @VerifiedAccount()
  @Throttle(KEY_THROTTLE)
  @UseGuards(VerifiedAccountGuard, UserThrottlerGuard)
  async save(
    @CurrentUser() user: RequestUser,
    @Body() dto: SaveOwnKeyDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    const { current_password, totp_code, publishable_key, restricted_key } =
      dto;
    await this.ownKey.assertCanSave(user.id, { publishable_key, restricted_key });
    return this.paymentKeys.run({
      scope: 'stripe_own_key',
      user,
      input: { current_password, totp_code },
      changed: { publishable_key, restricted_key },
      meta,
      always: true,
      apply: () =>
        this.ownKey.saveMine(user.id, { publishable_key, restricted_key }),
    });
  }

  @Post('verify')
  @Throttle(KEY_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  verify(@CurrentUser('id') userId: string) {
    return this.ownKey.verifyMine(userId);
  }

  @Delete()
  @Throttle(KEY_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  remove(
    @CurrentUser() user: RequestUser,
    @Body() dto: RemoveOwnKeyDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.paymentKeys.run({
      scope: 'stripe_own_key_removed',
      user,
      input: { current_password: dto.current_password, totp_code: dto.totp_code },
      changed: { publishable_key: '', restricted_key: '' },
      meta,
      always: true,
      apply: () => this.ownKey.removeMine(user.id),
    });
  }
}

// Admin store detail: own-key status and booleans only.
@Controller('admin/stores/:storeId/stripe-key')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminOwnKeyController {
  constructor(private readonly ownKey: OwnKeyService) {}

  @Get()
  get(@Param('storeId') storeId: string) {
    return this.ownKey.adminSummary(storeId);
  }
}
