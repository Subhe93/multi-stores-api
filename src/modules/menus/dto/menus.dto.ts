import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const KEY_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export class CreateMenuDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(KEY_REGEX, {
    message: 'key must be lowercase letters, digits, and hyphens',
  })
  key: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;
}

export class UpdateMenuDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(KEY_REGEX)
  key?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
}

export class MenuItemInputDto {
  @IsOptional()
  @IsString()
  id?: string; // present when editing an existing item

  @IsOptional()
  @IsString()
  parent_id?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label: string;

  // Per-locale label overrides, e.g. { ar: 'الرئيسية' }. `label` is the
  // primary-locale value and the fallback for any missing locale.
  @IsOptional()
  @IsObject()
  label_i18n?: Record<string, string>;

  @IsString()
  @MaxLength(500)
  url: string;

  @IsOptional()
  @IsBoolean()
  open_in_new_tab?: boolean;
}

// Full replace of a menu's items in one call. The editor sends the entire
// ordered list; the service diffs against existing rows. Order is implied
// by array position (sort_order = index).
export class SetMenuItemsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MenuItemInputDto)
  items: MenuItemInputDto[];
}
