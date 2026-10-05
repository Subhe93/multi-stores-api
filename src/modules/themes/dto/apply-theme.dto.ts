import { IsBoolean, IsOptional } from 'class-validator';

export class ApplyThemeDto {
  // Re-publish the HEADER / FOOTER pages that were already published (and
  // publish newly created ones) so the storefront reflects the new look at
  // once. Defaults to true. DRAFT pages always stay DRAFT.
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}
