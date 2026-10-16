import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Allow,
  ValidateIf,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AddCartItemDto {
  @IsOptional()
  @IsString()
  product_id?: string;

  @IsOptional()
  @IsString()
  variant_id?: string;

  @IsOptional()
  @IsString()
  custom_product_id?: string;

  @IsOptional()
  @IsString()
  bundle_offer_id?: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @Allow()
  custom_fields?: any;

  // Designer app (M4.2): the line's customer design; a designer line carries
  // no custom field values (any sent are dropped).
  @IsOptional()
  @IsUUID()
  design_id?: string;

  // Designer app: the guest design token; claims the design for the
  // customer (add / guest migration). Never stored on the row.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  design_token?: string;
}

export class UpdateCartItemDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity?: number;

  // Pass `null` to clear the bundle on this line.
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  bundle_offer_id?: string | null;

  // M4.0: replaces the line's personalization (validated like an add). A
  // line whose new values equal another line's merges into it.
  @IsOptional()
  @Allow()
  custom_fields?: unknown;
}
