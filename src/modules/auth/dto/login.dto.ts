import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  // Storefront login: customer accounts belong to one store, so the store
  // the shopper is on decides which account the email means. Without a
  // store context only staff accounts (dashboard / platform login) match.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_slug?: string;

  // Markets app: the storefront host. With store_slug it only picks the
  // origin of emailed links; alone it must be an ACTIVE domain of a store.
  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;
}
