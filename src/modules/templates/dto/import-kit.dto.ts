import { IsBoolean, IsOptional } from 'class-validator';

export class ImportKitDto {
  // When true, also create the kit's demo category + products so product
  // sections look populated immediately (Phase 5).
  @IsOptional()
  @IsBoolean()
  withDemoData?: boolean;
}
