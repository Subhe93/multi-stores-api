import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class MagicLoginDto {
  // Raw base64url token from the emailed link (43 characters in practice).
  @IsString()
  @MaxLength(256)
  token: string;

  // Storefront context: when present, the link must belong to a customer of
  // this store (checked before the link is consumed). The dashboard sends
  // none.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;
}

/**
 * Storefront guest checkout: the server creates the CUSTOMER with a
 * generated password and mails the credentials plus a magic login link.
 */
export class GuestRegisterDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  // Store the checkout ran on (required: store_slug or hostname, else 400
  // STORE_REQUIRED). The account belongs to that store; it also brands the
  // email and builds the links on the store domain.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_slug?: string;

  // Markets app: honoured only when it is an ACTIVE hostname of that store.
  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Za-z]{2})?$/)
  locale?: string;

  // Cloudflare Turnstile token; required only while the API runs with
  // TURNSTILE_CUSTOMERS=on (400 AUTH_CAPTCHA_FAILED otherwise).
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstile_token?: string;
}
