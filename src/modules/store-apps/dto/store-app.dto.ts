import { IsBoolean, IsObject, IsOptional } from 'class-validator';

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
