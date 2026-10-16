import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsInt,
  IsArray,
  IsObject,
  IsUUID,
  ValidateNested,
  Min,
  MaxLength,
  Matches,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CustomFieldType } from '@prisma/client';

/** Bounds of `translations[].option_labels` (`{optionValue: label}`). */
export const OPTION_LABELS_LIMITS = {
  entries: 200,
  keyLength: 200,
  labelLength: 500,
} as const;

/** True for null/undefined or a `{string: string}` map within the bounds. */
export function isBoundedLabelMap(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > OPTION_LABELS_LIMITS.entries) return false;
  return entries.every(
    ([k, label]) =>
      k.length <= OPTION_LABELS_LIMITS.keyLength &&
      (label === null ||
        (typeof label === 'string' &&
          label.length <= OPTION_LABELS_LIMITS.labelLength)),
  );
}

function IsBoundedLabelMap(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isBoundedLabelMap',
      validator: {
        validate: (v: unknown) => isBoundedLabelMap(v),
        defaultMessage: () =>
          `option_labels must be an object of at most ${OPTION_LABELS_LIMITS.entries} labels (strings of at most ${OPTION_LABELS_LIMITS.labelLength} characters)`,
      },
    },
    options,
  );
}

export class CustomFieldTranslationDto {
  @IsString()
  @MaxLength(10)
  @Matches(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/, {
    message: 'locale must be a language code such as "sv" or "en-US"',
  })
  locale: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  placeholder?: string;

  @IsOptional()
  @IsBoundedLabelMap()
  option_labels?: any;

  // Personalization app (M4.1, C6). Each key: undefined = keep the stored
  // value on update (X19), null = clear. Non-empty values need the app.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  display_label?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  sublabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  help_text?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  help_image_url?: string | null;

  @IsOptional()
  @IsObject()
  // { required?, pattern?, allowed_chars?, equal_length?, max_length?,
  //   min_checked?, max_checked? }; "{i}" = repeater item index.
  messages?: Record<string, string> | null;
}

/**
 * Personalization keys shared by create and update (M4.1 §4.2). The JSON
 * shapes are checked by the personalization config validator; `null`
 * clears a key, `undefined` leaves it alone. Any non-null value needs the
 * Personalization app on a creator-owned product.
 */

export class CreateCustomFieldDto {
  @IsString()
  name: string;

  @IsEnum(CustomFieldType)
  type: CustomFieldType;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsString()
  placeholder?: string;

  @IsOptional()
  options?: unknown; // JSON for select options

  @IsOptional()
  // { min_length?, max_length?, pattern?, allowed_chars?, min_checked?,
  // max_checked? }; checked by the
  // service (M4.0 §3.2); null clears.
  validation_rules?: unknown;

  @IsOptional()
  // { type, target (sibling field name), fill_char? | max }; checked and
  // normalized by the service (M4.0 K3); null clears.
  linked_validation?: unknown;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  // Personalization app (M4.1). REPEATER child → parent (same product).
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  pricing?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  repeat?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown> | null;

  // Audit keys written by presets / the importer; round-tripped by the editor.
  @IsOptional()
  @IsString()
  @MaxLength(48)
  preset_key?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  preset_ref?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldTranslationDto)
  translations?: CustomFieldTranslationDto[];
}

export class UpdateCustomFieldDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(CustomFieldType)
  type?: CustomFieldType;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsString()
  placeholder?: string;

  @IsOptional()
  options?: unknown;

  @IsOptional()
  validation_rules?: unknown;

  @IsOptional()
  linked_validation?: unknown;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  // Personalization app (M4.1). REPEATER child → parent (same product).
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  pricing?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  repeat?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown> | null;

  // Audit keys written by presets / the importer; round-tripped by the editor.
  @IsOptional()
  @IsString()
  @MaxLength(48)
  preset_key?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  preset_ref?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldTranslationDto)
  translations?: CustomFieldTranslationDto[];
}
