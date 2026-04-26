import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsInt,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateShippingZoneDto {
  @IsString()
  name: string;

  @IsArray()
  @IsString({ each: true })
  countries: string[]; // ISO codes

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  base_cost: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  per_item_cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  free_threshold?: number;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  estimated_days_min: number;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  estimated_days_max: number;
}

export class CreateShippingProfileDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShippingZoneDto)
  zones?: CreateShippingZoneDto[];
}

export class EstimateShippingDto {
  @IsArray()
  @IsString({ each: true })
  product_ids: string[];

  @IsString()
  country_code: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  item_count: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  subtotal: number;
}

export class CalculateShippingDto {
  @IsString()
  profile_id: string;

  @IsString()
  country_code: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  item_count: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  subtotal: number;
}
