import { IsObject, IsOptional } from 'class-validator';

// Partial update of a legal page. Title and content are per-locale maps
// merged into the stored JSON, so the admin can update one locale at a time.
export class UpdateLegalPageDto {
  @IsOptional()
  @IsObject()
  title?: Record<string, string>;

  @IsOptional()
  @IsObject()
  content?: Record<string, string>;
}
