import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// No "--" inside a key: the market-preview hostname is `<slug>--<key>` and
// splits on that separator.
const KEY_REGEX = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])?$/;
const KEY_MESSAGE =
  'key must be 1-16 lowercase letters, digits or hyphens (no leading/trailing or doubled hyphen)';
const COUNTRY_REGEX = /^[A-Za-z]{2}$/;
const LOCALE_REGEX = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;
const HOSTNAME_REGEX =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export class PriceRoundingDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  increment?: number;

  @IsOptional()
  @IsIn(['none', '.99', '.90', '.95', '9', '0'])
  ending?: 'none' | '.99' | '.90' | '.95' | '9' | '0';
}

export class PriceRuleDto {
  @IsIn(['convert', 'fixed'])
  mode: 'convert' | 'fixed';

  @IsOptional()
  @IsIn(['manual', 'platform'])
  source?: 'manual' | 'platform';

  @IsOptional()
  @IsNumber()
  @Min(0)
  rate?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRoundingDto)
  rounding?: PriceRoundingDto;
}

export class CreateMarketDto {
  @IsString()
  @Matches(KEY_REGEX, { message: KEY_MESSAGE })
  key: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsArray()
  @ArrayMaxSize(250)
  @Matches(COUNTRY_REGEX, { each: true })
  countries: string[];

  @IsString()
  @Matches(LOCALE_REGEX)
  default_locale: string;

  @IsArray()
  @ArrayMaxSize(10)
  @Matches(LOCALE_REGEX, { each: true })
  locales: string[];

  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRuleDto)
  price_rule?: PriceRuleDto;
}

export class UpdateMarketDto {
  @IsOptional()
  @IsString()
  @Matches(KEY_REGEX, { message: KEY_MESSAGE })
  key?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @Matches(COUNTRY_REGEX, { each: true })
  countries?: string[];

  @IsOptional()
  @IsString()
  @Matches(LOCALE_REGEX)
  default_locale?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(LOCALE_REGEX, { each: true })
  locales?: string[];

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRuleDto)
  price_rule?: PriceRuleDto;
}

export class SetMarketStatusDto {
  @IsIn(['DRAFT', 'LIVE'])
  status: 'DRAFT' | 'LIVE';
}

export class AddDomainDto {
  @IsString()
  @MaxLength(253)
  @Matches(HOSTNAME_REGEX, {
    message: 'hostname must be a valid domain like shop.example.com',
  })
  hostname: string;

  // Hostname of the same market this one should 301 to (www → apex).
  @IsOptional()
  @IsString()
  @MaxLength(253)
  @Matches(HOSTNAME_REGEX, {
    message: 'redirect_to must be a valid domain like shop.example.com',
  })
  redirect_to?: string | null;
}

export class SetDomainStatusDto {
  @IsIn(['PENDING', 'VERIFIED', 'ACTIVE'])
  status: 'PENDING' | 'VERIFIED' | 'ACTIVE';
}

export class VariantMarketPriceDto {
  @IsString()
  variant_id: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number | null;
}

export class ProductMarketPriceDto {
  @IsString()
  market_id: string;

  @IsOptional()
  @IsBoolean()
  available?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  compare_at_price?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VariantMarketPriceDto)
  variants?: VariantMarketPriceDto[];
}

export class UpsertProductMarketPricesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductMarketPriceDto)
  markets: ProductMarketPriceDto[];
}

export class FxRateDto {
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  base: string;

  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  quote: string;

  @IsNumber()
  @Min(0.00000001)
  rate: number;
}

export class UpsertFxRatesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FxRateDto)
  rates: FxRateDto[];
}
