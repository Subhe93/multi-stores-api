import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { OptionalJwtAuthGuard } from '../../../common/guards/optional-jwt.guard';
import {
  KustomCheckoutService,
  type KustomCallbackResult,
} from './kustom-checkout.service';
import {
  CreateKustomCheckoutSessionDto,
  UpdateKustomCheckoutSessionDto,
} from './dto/kustom-checkout.dto';

/**
 * Session-first Kustom checkout (API-CONTRACT-B.md). Two secrets per session:
 * the storefront `token` (returned to the browser) authenticates PUT
 * /session/:id and GET /confirmation; the server-side `callback_token`, only
 * ever placed in the merchant URLs handed to Kustom, authenticates the four
 * callbacks below. Neither is ever part of a JSON body sent to Kustom.
 */
@Controller('payments/kustom/checkout')
export class KustomCheckoutController {
  constructor(private readonly checkout: KustomCheckoutService) {}

  // ── Storefront ──────────────────────────────────────────────────────────

  // Guests send their cart lines; a logged-in customer may omit them to use
  // the server cart. A bad JWT is rejected, a missing one means guest.
  // Each session costs a Kustom API call and a database row, so this is
  // throttled tighter than the global backstop.
  @Post('session')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(OptionalJwtAuthGuard)
  createSession(
    @Req() req: Request & { user?: { id?: string } },
    @Body() dto: CreateKustomCheckoutSessionDto,
  ) {
    return this.checkout.createSession(req.user?.id ?? null, dto);
  }

  @Put('session/:id')
  updateSession(
    @Param('id') id: string,
    @Body() dto: UpdateKustomCheckoutSessionDto,
  ) {
    return this.checkout.updateSession(id, dto);
  }

  // Confirmation page: session token instead of a JWT, so guests whose
  // account was just created can see their receipt.
  @Get('confirmation')
  getConfirmation(
    @Query('session_id') sessionId: string | undefined,
    @Query('token') token: string | undefined,
  ) {
    return this.checkout.getConfirmation(sessionId ?? '', token ?? '');
  }

  // ── Kustom callbacks (public, never throttled) ──────────────────────────
  // Kustom waits at most 10 s (address / shipping option) or 3 s (validation)
  // and retries pushes on a fixed schedule; a throttled reply would fail the
  // purchase or delay the paid state by hours.

  // Kustom expects the re-priced order as the raw JSON body (no envelope),
  // so the response is written by hand. 303 + Location sends the customer
  // back to the checkout with an error.
  @SkipThrottle()
  @Post('address-update')
  async addressUpdate(
    @Query('session_id') sessionId: string | undefined,
    @Query('token') token: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    this.reply(
      res,
      await this.checkout.handleAddressUpdate(
        sessionId ?? '',
        token ?? '',
        body,
      ),
      true,
    );
  }

  @SkipThrottle()
  @Post('shipping-option-update')
  async shippingOptionUpdate(
    @Query('session_id') sessionId: string | undefined,
    @Query('token') token: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    this.reply(
      res,
      await this.checkout.handleShippingOptionUpdate(
        sessionId ?? '',
        token ?? '',
        body,
      ),
      true,
    );
  }

  // 200 approves the purchase (and has created the order), 303 rejects it.
  @SkipThrottle()
  @Post('validation')
  async validation(
    @Query('session_id') sessionId: string | undefined,
    @Query('token') token: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    this.reply(
      res,
      await this.checkout.handleValidation(sessionId ?? '', token ?? '', body),
      false,
    );
  }

  @SkipThrottle()
  @Post('push')
  push(
    @Query('session_id') sessionId: string | undefined,
    @Query('token') token: string | undefined,
    @Query('kustom_order_id') kustomOrderId: string | undefined,
  ) {
    return this.checkout.handlePush(
      sessionId ?? '',
      token ?? '',
      kustomOrderId ?? '',
    );
  }

  /** `raw` writes the body as-is (Kustom parses it); else the API envelope. */
  private reply(res: Response, result: KustomCallbackResult, raw: boolean) {
    if (!result.ok) {
      res.status(303).location(result.redirectUrl).end();
      return;
    }
    const body = result.body ?? { ok: true };
    res.status(200).json(raw ? body : { success: true, data: body });
  }
}
