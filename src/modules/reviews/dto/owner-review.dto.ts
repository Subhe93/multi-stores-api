import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * GET /stores/my/reviews. Every filter is read leniently by the service (an
 * unknown value is ignored, never an error), so the list never answers raw
 * validator text for a hand-edited URL.
 */
export class OwnerReviewsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  rating?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  product_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  limit?: string;
}

/** PATCH /stores/my/reviews/:id/status */
export class SetReviewStatusDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status: 'APPROVED' | 'REJECTED';

  // `updated_at` of the review as the owner read it. Checked by the service
  // (409 REVIEW_CHANGED when missing, malformed or stale), never by the
  // validator, so the dashboard always gets a coded answer.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  expected_updated_at?: string;
}

/** PUT /stores/my/reviews/:id/reply (1..1000 after normalisation: service). */
export class ReviewReplyDto {
  @IsString()
  @MaxLength(5000)
  body: string;

  // See SetReviewStatusDto.expected_updated_at.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  expected_updated_at?: string;
}

/** POST /stores/my/reviews/links */
export class CreateReviewLinksDto {
  @IsUUID()
  order_id: string;
}
