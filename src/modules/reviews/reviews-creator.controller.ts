import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ReviewsService } from './reviews.service';
import {
  CreateReviewLinksDto,
  OwnerReviewsQueryDto,
  ReviewReplyDto,
  SetReviewStatusDto,
} from './dto/owner-review.dto';

/**
 * Owner moderation of the store's reviews (M171). The store always comes
 * from the creator's JWT: no route takes a store id or slug, and a review of
 * another store answers 404 REVIEW_NOT_FOUND.
 *
 * No @RequireApp on purpose: the owner keeps moderating and deleting
 * existing reviews after switching the app off (as with invoices). Only link
 * creation needs the app (409 REVIEWS_NOT_ENABLED).
 *
 * There is deliberately no route that creates a review and none that edits
 * its rating, title, text or display name: reviews must be genuine.
 */
@Controller('stores/my/reviews')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class ReviewsCreatorController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query() query: OwnerReviewsQueryDto,
  ) {
    return this.reviews.ownerList(userId, query);
  }

  // Fixed segments before `:id`.
  @Get('pending-count')
  pendingCount(@CurrentUser('id') userId: string) {
    return this.reviews.pendingCount(userId);
  }

  @Post('links')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  createLinks(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReviewLinksDto,
  ) {
    return this.reviews.createLinks(userId, dto.order_id);
  }

  @Patch(':id/status')
  setStatus(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SetReviewStatusDto,
  ) {
    return this.reviews.setStatus(
      userId,
      id,
      dto.status,
      dto.expected_updated_at,
    );
  }

  @Put(':id/reply')
  setReply(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ReviewReplyDto,
  ) {
    return this.reviews.setReply(userId, id, dto.body, dto.expected_updated_at);
  }

  @Delete(':id/reply')
  removeReply(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.reviews.removeReply(userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.reviews.ownerDelete(userId, id);
  }
}
