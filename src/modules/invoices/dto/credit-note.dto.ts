import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/** POST /invoices/my/:id/credit-note. Omitted amount = full remaining. */
export class CreditNoteDto {
  /** Gross amount to credit, in the invoice currency (major units). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
