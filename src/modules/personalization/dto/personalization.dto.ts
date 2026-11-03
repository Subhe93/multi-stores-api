import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  PRESET_MODES,
  type PresetMode,
} from '../personalization-presets.service';
import { UploadUrlsInJson } from '../../../common/uploads/upload-url.transform';

/** POST personalization/my/products/:productId/presets/:key */
export class ApplyPresetDto {
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @IsOptional()
  @IsIn([...PRESET_MODES])
  mode?: PresetMode;
}

/** POST personalization/my/library: `{name, from_field_id}` or `{name, definition}`. */
export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsUUID()
  from_field_id?: string;

  @IsOptional()
  @IsObject()
  @UploadUrlsInJson()
  definition?: Record<string, unknown>;
}

/** PUT personalization/my/library/:id */
export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsObject()
  @UploadUrlsInJson()
  definition?: Record<string, unknown>;
}
