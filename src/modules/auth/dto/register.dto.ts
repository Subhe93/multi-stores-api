import {
  IsEmail,
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  IsIn,
  IsBoolean,
  Matches,
  MaxLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';

/** Sign-up cards of the register page (SPEC §2). */
export const ACCOUNT_KINDS = ['independent', 'marketplace', 'supplier'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  // Optional once `account_kind` is sent (it decides the role: independent /
  // marketplace → CREATOR, supplier → PROVIDER). Storefront customer sign-up
  // keeps sending role CUSTOMER without an account kind.
  @IsOptional()
  @IsEnum(UserRole, {
    message: 'role must be PROVIDER, CREATOR, or CUSTOMER',
  })
  role?: UserRole;

  // Required for staff sign-ups (400 when missing); ignored for customers.
  @IsOptional()
  @IsIn(ACCOUNT_KINDS)
  account_kind?: AccountKind;

  // Terms + privacy checkbox; must be true for staff sign-ups
  // (400 AUTH_TERMS_REQUIRED).
  @IsOptional()
  @IsBoolean()
  accept_terms?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  last_name?: string;

  // Supplier sign-up: the company (required for account_kind supplier).
  @IsOptional()
  @IsString()
  @MaxLength(150)
  company_name?: string;

  // ISO2 of the sign-up (supplier country / creator onboarding profile).
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  // Honeypot: hidden field a human never fills. Non-empty → a fake 200 and
  // nothing is created.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  // Storefront context. Required for role CUSTOMER (the account belongs to
  // that store; 400 STORE_REQUIRED without it), ignored for CREATOR /
  // PROVIDER. Also brands and localizes the welcome email.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Za-z]{2})?$/)
  locale?: string;
}

export class VerifyEmailDto {
  // Raw base64url token from the verification link.
  @IsString()
  @MaxLength(256)
  token: string;
}
