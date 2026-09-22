import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { SkipThrottle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../../common/decorators';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { KustomService } from './kustom.service';
import {
  KustomRefundDto,
  KustomSessionDto,
  UpdateKustomSettingsDto,
} from './dto/kustom.dto';

@Controller('payments/kustom')
export class KustomController {
  constructor(private readonly kustom: KustomService) {}

  // ── Customer (order-first checkout) ─────────────────────────────────────

  // Create or reuse the Kustom session for the customer's own order and
  // return the snippet the storefront embeds.
  @Post('session')
  @UseGuards(AuthGuard('jwt'))
  createSession(
    @CurrentUser('id') userId: string,
    @Body() dto: KustomSessionDto,
  ) {
    return this.kustom.createSession(userId, dto.order_id);
  }

  // Confirmation page: verifies the payment with Kustom, marks the order paid
  // if the push has not yet, and returns the confirmation snippet.
  @Get('confirmation')
  @UseGuards(AuthGuard('jwt'))
  getConfirmation(
    @CurrentUser('id') userId: string,
    @Query('order_id') orderId: string,
  ) {
    return this.kustom.getConfirmation(userId, orderId ?? '');
  }

  // ── Kustom callbacks (public) ───────────────────────────────────────────
  // Neither is signed; authenticity comes from the per-order secret token in
  // the URL plus a live re-read from Kustom (push). Never throttled: Kustom
  // retries pushes on a fixed schedule and a dropped one delays the paid
  // state by hours.

  @SkipThrottle()
  @Post('push')
  push(
    @Query('order_id') orderId: string,
    @Query('token') token: string,
    @Query('kustom_order_id') kustomOrderId: string,
  ) {
    return this.kustom.handlePush(
      orderId ?? '',
      token ?? '',
      kustomOrderId ?? '',
    );
  }

  // Kustom posts the full checkout order and waits at most 3 s: 200 approves
  // the purchase, 303 + Location sends the customer back with an error. The
  // response is written by hand because Nest would otherwise force the
  // method's default status code onto the redirect.
  @SkipThrottle()
  @Post('validation')
  async validation(
    @Query('order_id') orderId: string | undefined,
    @Query('token') token: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const result = await this.kustom.handleValidation(orderId, token, body);
    if (result.ok) {
      res.status(200).json({ success: true, data: { ok: true } });
      return;
    }
    res.status(303).location(result.redirectUrl).end();
  }

  // ── Creator settings ────────────────────────────────────────────────────

  @Get('settings')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  getSettings(@CurrentUser('id') userId: string) {
    return this.kustom.getSettings(userId);
  }

  @Put('settings')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateKustomSettingsDto,
  ) {
    return this.kustom.updateSettings(userId, dto);
  }

  @Post('settings/test')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  testSettings(@CurrentUser('id') userId: string) {
    return this.kustom.testSettings(userId);
  }

  // ── Order management (owning creator or admin) ──────────────────────────

  // Live order state from Kustom (status, captured / remaining amounts).
  @Get('orders/:orderId/status')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  liveStatus(
    @Param('orderId') orderId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.kustom.getLiveStatus(orderId, { userId, role });
  }

  @Post('orders/:orderId/capture')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  capture(
    @Param('orderId') orderId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.kustom.captureOrder(orderId, { userId, role });
  }

  @Post('orders/:orderId/refund')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  refund(
    @Param('orderId') orderId: string,
    @Body() dto: KustomRefundDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.kustom.refundOrder(orderId, dto.amount, { userId, role });
  }
}
