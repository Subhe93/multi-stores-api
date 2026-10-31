import {
  IsEmail,
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(UserRole, {
    message: 'role must be PROVIDER, CREATOR, or CUSTOMER',
  })
  role: UserRole;

  @IsOptional()
  @IsString()
  first_name?: string;

  @IsOptional()
  @IsString()
  last_name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  // Optional storefront context: brands and localizes the welcome email
  // (resolved server-side like forgot-password). Never affects the account.
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
