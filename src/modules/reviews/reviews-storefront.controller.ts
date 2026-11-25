import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  RequireAppGuard,
  type RequestWithAppStore,
} from '../../common/guards/require-app.guard';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import { ReqMeta, type RequestMeta } from '../security/request-meta';
import { ReviewsService } from './reviews.service';
import { parseReviewsPage } from './review-text';
import {
  LinkReviewDto,
  ReviewLinkContextDto,
  SubmitReviewDto,
} from './dto/submit-review.dto';

/** Store id resolved by RequireAppGuard from the `:slug` of the route. */
function storeIdOf(req: RequestWithAppStore | undefined): string {
  const id = req?.appStoreId;
  if (!id) {
    throw new ForbiddenException({
      code: 'STORE_APP_NOT_ENABLED',
      message: 'The "reviews" app is not enabled for this store.',
    });
  }
  return id;
}

/**
 * Storefront side of the reviews app (M171). Every route sits behind
 * @RequireApp('reviews'): with the app off (or the store not active) they
 * all answer 403 STORE_APP_NOT_ENABLED, so nothing is read or written.
 *
 * Three groups: the public read (no auth, not throttled: it comes from the
 * Next server), the signed-in customer (`reviews/mine`, CUSTOMER role, the
 * customer's own store only) and the review link (`reviews/link`, no login,
 * the token travels in the JSON body only).
 */
@Controller('storefront')
@RequireApp('reviews')
export class ReviewsStorefrontController {
  constructor(private readonly reviews: ReviewsService) {}

  // -- Public read -----------------------------------------------------------

  @Get(':slug/products/:productSlug/reviews')
  @SkipThrottle()
  @UseGuards(RequireAppGuard)
  list(
    @Req() req: RequestWithAppStore,
    @Param('productSlug') productSlug: string,
    @Query('page') page?: string,
  ) {
    return this.reviews.publicList(
      storeIdOf(req),
      productSlug,
      parseReviewsPage(page),
    );
  }

  // -- Signed-in customer ----------------------------------------------------
  // Guard order: 401 (no session) -> 403 (not a customer) -> 403 (app off).
  // Each handler then checks that the store of the slug is the customer's
  // own store (403 CUSTOMER_STORE_MISMATCH) before anything is read.

  @Get(':slug/reviews/mine/eligibility')
  @UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
  @Roles(UserRole.CUSTOMER)
  eligibility(
    @Req() req: RequestWithAppStore,
    @CurrentUser() user: RequestUser,
    @Query('product_id') productId: string,
  ) {
    return this.reviews.eligibility(user, storeIdOf(req), productId);
  }

  @Get(':slug/reviews/mine/orders/:orderId')
  @UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
  @Roles(UserRole.CUSTOMER)
  myOrderItems(
    @Req() req: RequestWithAppStore,
    @CurrentUser() user: RequestUser,
    @Param('orderId') orderId: string,
  ) {
    return this.reviews.myOrderItems(user, storeIdOf(req), orderId);
  }

  // Per customer and hour: reviews are rare, and under auto-publish every
  // accepted edit revalidates the store. (The global guard applies the same
  // budget per IP.)
  @Put(':slug/reviews/mine')
  @UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard, UserThrottlerGuard)
  @Roles(UserRole.CUSTOMER)
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  submitMine(
    @Req() req: RequestWithAppStore,
    @CurrentUser() user: RequestUser,
    @Body() dto: SubmitReviewDto,
  ) {
    return this.reviews.submitMine(user, storeIdOf(req), dto);
  }

  @Delete(':slug/reviews/mine/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
  @Roles(UserRole.CUSTOMER)
  deleteMine(
    @Req() req: RequestWithAppStore,
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    return this.reviews.deleteMine(user, storeIdOf(req), id);
  }

  // -- Review link (no login) ------------------------------------------------

  @Post(':slug/reviews/link/context')
  @HttpCode(200)
  @UseGuards(RequireAppGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  linkContext(
    @Req() req: RequestWithAppStore,
    @Body() dto: ReviewLinkContextDto,
  ) {
    return this.reviews.linkContext(storeIdOf(req), dto.token);
  }

  @Put(':slug/reviews/link')
  @UseGuards(RequireAppGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  submitLink(
    @Req() req: RequestWithAppStore,
    @Body() dto: LinkReviewDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.reviews.submitLink(storeIdOf(req), dto, { ip: meta.ip });
  }
}
