import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Step-up fields accepted by every sensitive endpoint. */
export class ReauthDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  current_password?: string;

  // 6-digit app code or a recovery code (XXXXX-XXXXX).
  @IsOptional()
  @IsString()
  @MaxLength(20)
  totp_code?: string;

  // Admin user management only: grant from POST /admin/reauth.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reauth_token?: string;
}

export class TwoFactorSetupDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  current_password?: string;
}

export class TwoFactorEnableDto {
  @IsString()
  @MaxLength(20)
  code: string;
}

export class TwoFactorConfirmDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  current_password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;
}

export class TwoFactorLoginDto {
  @IsString()
  @MaxLength(2000)
  challenge_token: string;

  @IsString()
  @MaxLength(20)
  code: string;
}
