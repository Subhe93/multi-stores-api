import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CartService } from './cart.service';
import { isPreview } from '../markets/preview-query';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';
import {
  STOREFRONT_VIEWER_HEADER,
  StorefrontGateService,
} from '../storefront/storefront-gate.service';

@Controller('cart')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CUSTOMER)
export class CartController {
  constructor(
    private cartService: CartService,
    private gate: StorefrontGateService,
  ) {}

  // ?market= (markets app): prices are returned in that market's currency.
  // ?preview=1 (market-preview host): a DRAFT market prices the cart too.
  // ?buyer=company (b2b app): the company view (net block, per-line rates).
  @Get()
  getCart(
    @CurrentUser('id') userId: string,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('buyer') buyer?: string,
    @Query('preview') preview?: string,
  ) {
    return this.cartService.getCart(
      userId,
      locale,
      market,
      buyer,
      isPreview(preview),
    );
  }

  // Optional `X-Storefront-Viewer: Bearer <token>` (FIXES-1 item 4): the
  // owner / an admin previewing a store that is not LIVE may fill the cart
  // (the guest cart is moved here at checkout); order creation keeps its
  // own pre-live rule (TEST own key + Stripe only).
  @Post('items')
  addItem(
    @CurrentUser('id') userId: string,
    @Body() dto: AddCartItemDto,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('buyer') buyer?: string,
    @Query('preview') preview?: string,
    @Headers(STOREFRONT_VIEWER_HEADER) viewerHeader?: string,
  ) {
    const preLiveViewer = this.gate.preLiveCheck(viewerHeader);
    return this.cartService.addItem(
      userId,
      dto,
      locale,
      market,
      buyer,
      isPreview(preview),
      preLiveViewer,
    );
  }

  @Put('items/:id')
  updateItem(
    @CurrentUser('id') userId: string,
    @Param('id') itemId: string,
    @Body() dto: UpdateCartItemDto,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('buyer') buyer?: string,
    @Query('preview') preview?: string,
  ) {
    return this.cartService.updateItem(
      userId,
      itemId,
      dto,
      locale,
      market,
      buyer,
      isPreview(preview),
    );
  }

  @Delete('items/:id')
  removeItem(
    @CurrentUser('id') userId: string,
    @Param('id') itemId: string,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('buyer') buyer?: string,
    @Query('preview') preview?: string,
  ) {
    return this.cartService.removeItem(
      userId,
      itemId,
      locale,
      market,
      buyer,
      isPreview(preview),
    );
  }

  @Delete()
  clearCart(@CurrentUser('id') userId: string) {
    return this.cartService.clearCart(userId);
  }

  @Post('apply-coupon')
  applyCoupon(
    @CurrentUser('id') userId: string,
    @Body('coupon_code') couponCode: string,
  ) {
    return this.cartService.applyCoupon(userId, couponCode);
  }

  @Delete('remove-coupon')
  removeCoupon(@CurrentUser('id') userId: string) {
    return this.cartService.removeCoupon(userId);
  }
}
