import { Module } from '@nestjs/common';
import { DesignerAssetsModule } from '../designer-assets.module';
import { NppDesignerImportPort } from './npp-designer-import.port';
import { NppImportService } from './npp-import.service';

/**
 * NPP import of the designer app (M4.2 WP7): the import service and the real
 * `DesignerImportPort`. Cycle-free (Prisma, PRIVATE_STORAGE and StoreApps are
 * global), so `ImporterModule` imports it to rebind `DESIGNER_IMPORT_PORT`.
 */
@Module({
  imports: [DesignerAssetsModule],
  providers: [NppImportService, NppDesignerImportPort],
  exports: [NppImportService, NppDesignerImportPort],
})
export class DesignerImportModule {}
