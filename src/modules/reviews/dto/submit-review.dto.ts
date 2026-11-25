import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { REVIEW_LINK_TOKEN_MAX_LENGTH } from '../review-link-token.service';

// The DTOs check the type and a generous size only (whitelist +
// forbidNonWhitelisted come from the global pipe). The real limits live in
// review-text.ts and answer coded errors (REVIEW_*), so a form never has to
// show raw validator text for a rule a person can break.

/** Text fields shared by the two write routes. */
class ReviewFieldsDto {
  // 1..5, an integer: checked by the service (REVIEW_RATING_INVALID).
  @IsNumber()
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsString()
  @MaxLength(10000)
  body: string;

  @IsString()
  @MaxLength(200)
  display_name: string;

  @IsString()
  @MaxLength(10)
  locale: string;

  // Honeypot: a hidden field a person never fills in.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstile_token?: string;
}

/** PUT /storefront/:slug/reviews/mine */
export class SubmitReviewDto extends ReviewFieldsDto {
  // The storefront product id (a Product.id or a CustomProduct.id).
  @IsUUID()
  product_id: string;
}

/** PUT /storefront/:slug/reviews/link */
export class LinkReviewDto extends ReviewFieldsDto {
  @IsString()
  @MaxLength(REVIEW_LINK_TOKEN_MAX_LENGTH)
  token: string;
}

/** POST /storefront/:slug/reviews/link/context */
export class ReviewLinkContextDto {
  @IsString()
  @MaxLength(REVIEW_LINK_TOKEN_MAX_LENGTH)
  token: string;
}
