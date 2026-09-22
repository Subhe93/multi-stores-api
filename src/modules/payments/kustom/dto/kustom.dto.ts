import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

// Order-first flow: like Stripe, the client only names the order. Everything
// that affects money (amount, currency, merchant account) is derived from the
// order row on the server.
export class KustomSessionDto {
  @IsString()
  order_id: string;
}

// Creator-managed Kustom credentials. All optional so one field can be updated
// at a time; an empty string clears merchant_id / shared_secret.
export class UpdateKustomSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  merchant_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  shared_secret?: string;

  @IsOptional()
  @IsIn(['playground', 'production'])
  environment?: 'playground' | 'production';

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // When to capture the authorization; see Creator.kustom_capture_mode.
  @IsOptional()
  @IsIn(['on_shipment', 'immediate'])
  capture_mode?: 'on_shipment' | 'immediate';
}

// Refund amount in MAJOR units of the order currency; omitted means a full
// refund of the order total.
export class KustomRefundDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;
}
