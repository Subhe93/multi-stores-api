import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  Req,
  Headers,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { PaymentsService } from './payments.service';
import {
  CreatePaymentIntentDto,
  UpdateStripeSettingsDto,
} from './dto/payments.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  // Public — frontend checks if Stripe is available. With ?store=<slug>, the
  // config is store-aware: independent stores also return the connected
  // account Stripe.js must target for their direct charges.
  @Get('config')
  getConfig(@Query('store') store?: string) {
    return this.paymentsService.getPublicConfig(store);
  }

  // ── Admin platform Stripe settings ──────────────────────────────────────────

  @Get('admin/settings')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  getAdminSettings() {
    return this.paymentsService.getAdminSettings();
  }

  @Put('admin/settings')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  updateAdminSettings(@Body() dto: UpdateStripeSettingsDto) {
    return this.paymentsService.updateAdminSettings(dto);
  }

  // ── Stripe Connect (creator onboarding) ────────────────────────────────────

  @Post('connect/account')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.PROVIDER)
  async createConnectAccount(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const accountId = await this.paymentsService.getOrCreateConnectedAccount(
      userId,
      role,
    );
    return { accountId };
  }

  @Get('connect/onboarding-link')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.PROVIDER)
  getOnboardingLink(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.paymentsService.createOnboardingLink(userId, role);
  }

  @Get('connect/status')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.PROVIDER)
  getConnectStatus(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.paymentsService.getConnectStatus(userId, role);
  }

  // ── Checkout (order-first) ──────────────────────────────────────────────────

  @Post('create-intent')
  @UseGuards(AuthGuard('jwt'))
  createIntent(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePaymentIntentDto,
  ) {
    return this.paymentsService.createPaymentIntentForOrder(
      userId,
      dto.order_id,
    );
  }

  // Customer — finalize own order right after confirming the card payment,
  // so status doesn't depend on the webhook arriving.
  @Post('confirm')
  @UseGuards(AuthGuard('jwt'))
  confirm(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePaymentIntentDto,
  ) {
    return this.paymentsService.confirmOrderPayment(userId, dto.order_id);
  }

  // Admin — manually reconcile a stuck order's payment from Stripe.
  @Post('admin/orders/:orderId/reconcile')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  reconcile(@Param('orderId') orderId: string) {
    return this.paymentsService.reconcilePayment(orderId);
  }

  // ── Stripe webhook ──────────────────────────────────────────────────────────
  // Public + signature-verified. Reads the raw request body (enabled in main.ts
  // via rawBody) so the Stripe signature check works on the exact bytes.
  @Post('webhook')
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing request body');
    }
    let event;
    try {
      event = await this.paymentsService.constructWebhookEvent(
        req.rawBody,
        signature,
      );
    } catch {
      // Bad signature or malformed payload — reject so Stripe surfaces the error.
      throw new BadRequestException('Invalid webhook signature');
    }
    await this.paymentsService.handleWebhookEvent(event);
    return { received: true };
  }

  // ── Stripe Connect webhook ──────────────────────────────────────────────────
  // Public + signature-verified with its OWN signing secret. Receives events
  // that occurred on connected accounts (independent stores' direct charges);
  // event handling is shared with the platform endpoint.
  @Post('webhook/connect')
  async connectWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing request body');
    }
    let event;
    try {
      event = await this.paymentsService.constructConnectWebhookEvent(
        req.rawBody,
        signature,
      );
    } catch {
      // Bad signature or malformed payload — reject so Stripe surfaces the error.
      throw new BadRequestException('Invalid webhook signature');
    }
    await this.paymentsService.handleWebhookEvent(event);
    return { received: true };
  }
}
