import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsEmail,
  Min,
  Max,
} from 'class-validator';

// Admin-managed SMTP settings. All optional so one field can be updated at a
// time; an empty string clears a value, and a blank password leaves it unchanged.
export class UpdateSmtpSettingsDto {
  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsOptional()
  @IsString()
  user?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  from?: string;
}

export class SendTestEmailDto {
  @IsOptional()
  @IsEmail()
  to?: string;
}
