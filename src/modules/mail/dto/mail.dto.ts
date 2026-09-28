import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIn,
  IsInt,
  IsEmail,
  IsNumberString,
  MaxLength,
  Min,
  Max,
  ValidateIf,
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

// Same shape as the platform settings, plus an on/off switch: a creator can
// save their SMTP details and only turn the sender on once a test succeeds.
export class UpdateStoreSmtpSettingsDto extends UpdateSmtpSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SendTestEmailDto {
  @IsOptional()
  @IsEmail()
  to?: string;
}

// Delivery log filters. Query strings, so numbers arrive as text.
export class EmailLogQueryDto {
  @IsOptional()
  @IsNumberString()
  page?: string;

  @IsOptional()
  @IsNumberString()
  limit?: string;

  @IsOptional()
  @IsIn(['SENT', 'FAILED', 'SKIPPED'])
  status?: 'SENT' | 'FAILED' | 'SKIPPED';

  // Matches the recipient or the subject.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  // Admin only; ignored on the creator endpoint.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  store_id?: string;
}

// Address for "new order" notifications; an empty string clears it (back to
// the creator's login email).
export class UpdateStoreNotificationsDto {
  @IsOptional()
  @ValidateIf((o: UpdateStoreNotificationsDto) => o.notification_email !== '')
  @IsEmail()
  @MaxLength(254)
  notification_email?: string;
}
