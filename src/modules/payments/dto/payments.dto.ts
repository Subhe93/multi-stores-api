import { IsString, IsOptional } from 'class-validator';

// Order-first flow: the client only sends the order id. The server derives the
// charge amount, currency, and Connect destination from the order itself, so a
// tampered client cannot pay less than the order total.
export class CreatePaymentIntentDto {
  @IsString()
  order_id: string;
}

// Admin-managed platform Stripe credentials. All optional so the admin can
// update one field at a time; an empty string clears that value.
export class UpdateStripeSettingsDto {
  @IsOptional()
  @IsString()
  secret_key?: string;

  @IsOptional()
  @IsString()
  publishable_key?: string;

  @IsOptional()
  @IsString()
  webhook_secret?: string;

  // Signing secret of the Connect (connected accounts) webhook endpoint.
  @IsOptional()
  @IsString()
  connect_webhook_secret?: string;

  // Platform's Kustom partner id (sent as the Kustom-Partner header). Plain
  // text; an empty string clears it.
  @IsOptional()
  @IsString()
  kustom_partner_id?: string;
}
