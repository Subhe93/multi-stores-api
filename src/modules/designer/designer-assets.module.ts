import { Module } from '@nestjs/common';
import {
  DesignerAssetsCreatorController,
  DesignerFilesPublicController,
} from './designer-assets.controller';
import { DesignerAssetsService } from './designer-assets.service';
import {
  DesignerFontsCreatorController,
  DesignerFontsPublicController,
} from './designer-fonts.controller';
import { DesignerFontsService } from './designer-fonts.service';
import { DesignerUploadAdmission } from './designer-upload-admission';
import { DesignerUrlsService } from './designer-urls';

/**
 * Storage, assets, fonts and signed links of the designer app (M4.2 WP3).
 * Cycle-free (Prisma, PRIVATE_STORAGE and StoreAppsService are global), so
 * WP4's DesignerCoreModule (imported by Cart/Orders) can import it for
 * `DesignerUrlsService` / `DesignerAssetsService`.
 */
@Module({
  controllers: [
    DesignerAssetsCreatorController,
    DesignerFilesPublicController,
    DesignerFontsCreatorController,
    DesignerFontsPublicController,
  ],
  providers: [
    DesignerUrlsService,
    DesignerAssetsService,
    DesignerFontsService,
    DesignerUploadAdmission,
  ],
  exports: [
    DesignerUrlsService,
    DesignerAssetsService,
    DesignerFontsService,
    DesignerUploadAdmission,
  ],
})
export class DesignerAssetsModule {}
