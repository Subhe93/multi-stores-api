import { StoreType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

// Creator: toggle an app and/or replace its settings. The app key travels in
// the path and is validated against the registry by the service.
export class UpdateMyStoreAppDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

// Admin: allow (or withdraw) an app for a store. Withdrawing also switches
// the creator's own toggle off.
export class SetStoreAppAvailableDto {
  @IsBoolean()
  available: boolean;
}

// Admin: every store with its apps, paginated. `q` matches the store name,
// the store slug or the creator's display name (case-insensitive).
export class AdminStoreAppsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(StoreType)
  type?: StoreType;
}
