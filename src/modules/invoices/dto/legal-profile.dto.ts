import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

// PUT /invoices/my/legal-profile. Every field is optional so the form can be
// saved progressively; null (or '') clears a field. Format checks that need
// normalization (IBAN mod-97, bankgiro mod-10, BIC, VAT number) run in
// LegalProfileService and raise INVOICE_*_INVALID codes.

/** Validate only when a non-empty value was sent (null / '' clear). */
const present = (_: object, v: unknown) =>
  v !== null && v !== undefined && v !== '';

export class UpdateLegalProfileDto {
  @IsOptional() @IsString() @MaxLength(200) legal_name?: string | null;
  @IsOptional() @IsString() @MaxLength(200) brand_name?: string | null;
  @IsOptional() @IsString() @MaxLength(32) org_number?: string | null;
  @IsOptional() @IsString() @MaxLength(32) vat_number?: string | null;
  @IsOptional() @IsString() @MaxLength(200) address_line1?: string | null;
  @IsOptional() @IsString() @MaxLength(200) address_line2?: string | null;
  @IsOptional() @IsString() @MaxLength(16) postal_code?: string | null;
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;

  @IsOptional()
  @ValidateIf(present)
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'country_code must be an ISO2 code' })
  country_code?: string | null;

  @IsOptional() @IsString() @MaxLength(120) registered_office?: string | null;

  @IsOptional()
  @ValidateIf(present)
  @IsEmail()
  @MaxLength(200)
  email?: string | null;

  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(200) website?: string | null;
  @IsOptional() @IsString() @MaxLength(16) bankgiro?: string | null;
  @IsOptional() @IsString() @MaxLength(16) plusgiro?: string | null;
  @IsOptional() @IsString() @MaxLength(42) iban?: string | null;
  @IsOptional() @IsString() @MaxLength(11) bic?: string | null;
  @IsOptional() @IsString() @MaxLength(120) bank_name?: string | null;

  @IsOptional()
  @ValidateIf(present)
  @IsString()
  @MaxLength(500)
  // Only uploaded files: the PDF renderer reads logos from local uploads and
  // never fetches remote URLs, so an https logo would be silently dropped.
  @Matches(/^\/uploads\/[^\s]+$/, {
    message: 'logo_url must be an /uploads/ path',
  })
  logo_url?: string | null;

  @IsOptional() @IsBoolean() f_tax_approved?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(120) due_days?: number;

  @IsOptional() @IsString() @MaxLength(1000) footer_note?: string | null;

  /** IANA zone; checked against the runtime in the service. */
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}
