import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** `POST /storefront/:slug/personalization/validate` body (contract §3, `ValidateBody`). */
export class ValidatePersonalizationDto {
  @IsUUID()
  product_id: string;

  @IsOptional()
  @IsUUID()
  variant_id?: string | null;

  /** `{fieldId: value, repeaterId: [{childId: value}]}`; checked by the evaluator. */
  @IsOptional()
  @IsObject()
  custom_fields?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string | null;

  /** Markets app: the request market key (default market when absent). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  market?: string | null;

  /** Line quantity; prices are per unit, so it only bounds the request. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity?: number;
}
