import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Empty, or up to 12 characters ending in a non-digit ("INV-", "2026/"). */
export const INVOICE_PREFIX_PATTERN = /^([A-Za-z0-9._/-]{0,11}[A-Za-z._/-])?$/;

export class NumberingSequenceDto {
  @IsOptional()
  @IsString()
  @Matches(INVOICE_PREFIX_PATTERN, {
    message:
      'prefix must be empty or up to 12 characters (letters, digits, . _ / -) ending in a non-digit',
  })
  prefix?: string;

  @IsOptional() @IsInt() @Min(1) @Max(999999999) next_number?: number;

  @IsOptional() @IsInt() @Min(0) @Max(10) padding?: number;
}

/** PUT /invoices/my/numbering. */
export class UpdateNumberingDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => NumberingSequenceDto)
  invoice?: NumberingSequenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NumberingSequenceDto)
  credit_note?: NumberingSequenceDto;
}
