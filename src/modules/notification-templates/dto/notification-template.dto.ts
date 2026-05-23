import { IsBoolean, IsObject, IsOptional } from 'class-validator';

// Partial update — per-locale subject/body maps are merged into the stored JSON,
// so the admin can edit one locale at a time without dropping the others.
export class UpdateNotificationTemplateDto {
  @IsOptional()
  @IsObject()
  subject?: Record<string, string>;

  @IsOptional()
  @IsObject()
  body_html?: Record<string, string>;

  @IsOptional()
  @IsObject()
  body_text?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
