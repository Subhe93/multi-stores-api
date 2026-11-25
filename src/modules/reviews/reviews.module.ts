import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TurnstileService } from '../../common/security/turnstile.service';
import { ReviewsStorefrontController } from './reviews-storefront.controller';
import { ReviewsCreatorController } from './reviews-creator.controller';
import { ReviewsService } from './reviews.service';
import { ReviewLinkTokenService } from './review-link-token.service';

// M171 product reviews (store app `reviews`). Imports only globals (Prisma,
// Config, StoreApps, Revalidation) plus an option-less JwtModule (the secret
// is passed per call, rotation aware), so OrdersModule can import it for the
// hideForOrders hook without a cycle. TurnstileService is stateless (config
// only), provided here as in AuthModule.
@Module({
  imports: [JwtModule.register({})],
  controllers: [ReviewsStorefrontController, ReviewsCreatorController],
  providers: [ReviewsService, ReviewLinkTokenService, TurnstileService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
