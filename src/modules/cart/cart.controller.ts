import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CartService } from './cart.service';
import { isPreview } from '../markets/preview-query';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('cart')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CUSTOMER)
export class CartController {
  constructor(private cartService: CartService) {}

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

  @Post('items')
  addItem(
    @CurrentUser('id') userId: string,
    @Body() dto: AddCartItemDto,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('buyer') buyer?: string,
    @Query('preview') preview?: string,
  ) {
    return this.cartService.addItem(
      userId,
      dto,
      locale,
      market,
      buyer,
      isPreview(preview),
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
