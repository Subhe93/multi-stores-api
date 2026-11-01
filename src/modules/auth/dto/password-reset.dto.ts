import {
  IsEmail,
  IsString,
  IsOptional,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email: string;

  // Storefront request: only the customer account of that store is meant and
  // the reset link is built on the store's domain. Without a store context
  // only staff accounts match.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_slug?: string;

  // Markets app: the storefront host the request came from. Honoured only
  // when it is an ACTIVE hostname of that store (never an open redirect).
  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;
}

export class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  password: string;
}
