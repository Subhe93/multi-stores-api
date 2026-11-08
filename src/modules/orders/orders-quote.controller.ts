import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { QuoteOrderDto } from './dto/order.dto';
import { CurrentUser } from '../../common/decorators';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt.guard';
import {
  STOREFRONT_VIEWER_HEADER,
  StorefrontGateService,
} from '../storefront/storefront-gate.service';

/**
 * `POST /orders/quote` (API-CONTRACT-TAX.md §3): price lines for a
 * destination — shipping, coupon and taxes — without creating an order.
 * Guests send their lines; a logged-in customer may omit them to quote the
 * server cart. Kept apart from OrdersController, whose class-level JWT guard
 * would reject anonymous callers.
 */
@Controller('orders')
export class OrdersQuoteController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly gate: StorefrontGateService,
  ) {}

  // Public and database-heavy (shipping, coupon and tax resolution per call),
  // so it gets a tighter budget than the global limit. Optional
  // `X-Storefront-Viewer: Bearer <token>` (FIXES-1 item 4): the owner / an
  // admin may quote a store that is not LIVE when it has a TEST own key.
  @Post('quote')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(OptionalJwtAuthGuard)
  quote(
    @CurrentUser('id') userId: string | undefined,
    @Body() dto: QuoteOrderDto,
    @Headers(STOREFRONT_VIEWER_HEADER) viewerHeader?: string,
  ) {
    return this.ordersService.quote(
      userId ?? null,
      dto,
      this.gate.preLiveCheck(viewerHeader),
    );
  }
}
