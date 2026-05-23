import { IsEmail, IsString, IsOptional, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email: string;

  // When the request comes from a store storefront, the reset link is built on
  // that store's domain so the customer stays in the same storefront.
  @IsOptional()
  @IsString()
  store_slug?: string;
}

export class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  password: string;
}
