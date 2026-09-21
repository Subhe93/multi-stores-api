import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { QuoteOrderDto } from './dto/order.dto';
import { CurrentUser } from '../../common/decorators';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt.guard';

/**
 * `POST /orders/quote` (API-CONTRACT-TAX.md §3): price lines for a
 * destination — shipping, coupon and taxes — without creating an order.
 * Guests send their lines; a logged-in customer may omit them to quote the
 * server cart. Kept apart from OrdersController, whose class-level JWT guard
 * would reject anonymous callers.
 */
@Controller('orders')
export class OrdersQuoteController {
  constructor(private readonly ordersService: OrdersService) {}

  // Public and database-heavy (shipping, coupon and tax resolution per call),
  // so it gets a tighter budget than the global limit.
  @Post('quote')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(OptionalJwtAuthGuard)
  quote(
    @CurrentUser('id') userId: string | undefined,
    @Body() dto: QuoteOrderDto,
  ) {
    return this.ordersService.quote(userId ?? null, dto);
  }
}
