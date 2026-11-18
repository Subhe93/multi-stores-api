import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GuestOrderService } from './guest-order.service';
import { GuestOrderDto } from './dto/guest-order.dto';
import {
  STOREFRONT_VIEWER_HEADER,
  StorefrontGateService,
} from '../storefront/storefront-gate.service';
import { ReqMeta, type RequestMeta } from '../security/request-meta';
import { buildTrackingContext } from '../meta-capi/tracking-context';
import { GuestOrder, GuestOrderGuard } from '../auth/guest-order.guard';
import type { GuestOrderClaims } from '../auth/guest-order-token.service';

/**
 * Guest checkout routes. Kept apart from OrdersController, whose
 * class-level JWT guard would reject a shopper without a session (like
 * OrdersQuoteController).
 */
@Controller('orders')
export class OrdersGuestController {
  constructor(
    private readonly guestOrders: GuestOrderService,
    private readonly gate: StorefrontGateService,
  ) {}

  // Public write: it creates an order (and, for a new email, a customer
  // record), so it gets the same captcha as the guest sign-up it replaces
  // and a tight budget. Optional `X-Storefront-Viewer` as on POST /orders.
  @Post('guest')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  place(
    @Body() dto: GuestOrderDto,
    @ReqMeta() meta: RequestMeta,
    @Headers(STOREFRONT_VIEWER_HEADER) viewerHeader?: string,
  ) {
    const preLiveViewer = this.gate.preLiveCheck(viewerHeader);
    const trackingContext = buildTrackingContext(dto.tracking, meta);
    return this.guestOrders.place(dto, {
      ip: meta.ip,
      ...(preLiveViewer ? { preLiveViewer } : {}),
      ...(trackingContext ? { trackingContext } : {}),
    });
  }

  // The token's own order, for the confirmation page of a guest.
  @Get('guest/:id')
  @UseGuards(GuestOrderGuard)
  read(@GuestOrder() claims: GuestOrderClaims, @Param('id') id: string) {
    return this.guestOrders.read(claims, id);
  }
}
