import { IsIn, IsString, IsOptional, Length, Matches } from 'class-validator';
import { UploadUrl } from '../../../common/uploads/upload-url.transform';

export class CreateCreatorDto {
  @IsString()
  @Length(2, 50)
  display_name: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class UpdateCreatorDto {
  @IsOptional()
  @IsString()
  @Length(2, 50)
  display_name?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @UploadUrl()
  avatar_url?: string;
}

/** Survey answers of `Creator.onboarding_profile` (onboarding SPEC §1). */
export const ONBOARDING_STAGES = [
  'starting',
  'selling_online',
  'physical_shop',
  'agency',
] as const;
export const ONBOARDING_SELLS = ['own', 'suppliers', 'both'] as const;

/**
 * PUT /creators/me/onboarding-profile: the first-run survey (stage, what
 * is sold, country). Every field optional; given fields are merged into the
 * stored profile (the sign-up card's `account_kind` is never overwritten).
 */
export class OnboardingProfileDto {
  @IsOptional()
  @IsString()
  @IsIn(ONBOARDING_STAGES)
  stage?: (typeof ONBOARDING_STAGES)[number];

  @IsOptional()
  @IsString()
  @IsIn(ONBOARDING_SELLS)
  sells?: (typeof ONBOARDING_SELLS)[number];

  /** ISO 3166-1 alpha-2, stored upper case. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be an ISO2 code' })
  country?: string;
}
