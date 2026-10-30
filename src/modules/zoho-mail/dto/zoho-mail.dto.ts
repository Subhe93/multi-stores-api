import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/** Region is checked in the service so a bad value gets ZOHO_MAIL_INVALID_REGION. */
export class ZohoClientDto {
  @IsString()
  @MaxLength(32)
  region!: string;

  @IsString()
  @MaxLength(200)
  client_id!: string;

  /** Omitted or empty = keep the stored secret. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  client_secret?: string;
}

export class ZohoUpdateSenderDto {
  @IsString()
  @MaxLength(320)
  from_address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  from_name?: string | null;
}

export class ZohoTestDto {
  @IsEmail()
  @MaxLength(320)
  to!: string;
}
