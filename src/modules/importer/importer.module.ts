import { Module } from '@nestjs/common';
import {
  DESIGNER_IMPORT_PORT,
  NullDesignerImportPort,
  type DesignerImportPort,
} from '../../common/ports/designer-import.port';
import { DesignerImportModule } from '../designer/npp/designer-import.module';
import { NppDesignerImportPort } from '../designer/npp/npp-designer-import.port';
import { RedirectsModule } from '../redirects/redirects.module';
import { UploadsModule } from '../uploads/uploads.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { ImporterCreatorController } from './importer-creator.controller';
import { ImporterAdminController } from './importer-admin.controller';
import { importerHtmlSanitizerProvider } from './html/html-sanitizer';
import {
  PERSONALIZATION_PRESET_PORT,
  PersonalizationPresetPortAdapter,
} from './ports/personalization.port';
import { ImportSourcesService } from './sources/import-sources.service';
import { ImportEngineService } from './runs/import-engine.service';
import { ImportRunsService } from './runs/import-runs.service';
import { ImportWorkerService } from './runs/import-worker.service';
import { ImporterRetentionTask } from './runs/importer-retention.task';

/**
 * Importer store app (M4.4). Prisma, Crypto, StoreApps, Revalidation,
 * private storage and retention are global modules. Ports:
 * - `PERSONALIZATION_PRESET_PORT` → M4.1 `PersonalizationPresetsService.applyInTx` (C25);
 * - `DESIGNER_IMPORT_PORT` → M4.2 WP7 `NppDesignerImportPort` (C26); it acts as
 *   the Null port per call for stores whose designer app is off, and the
 *   Null port is bound when the designer module is not provided;
 * - `IMPORTER_HTML_SANITIZER` → plain-text fallback until `sanitize-html` is approved.
 */
@Module({
  imports: [
    RedirectsModule,
    UploadsModule,
    PersonalizationModule,
    DesignerImportModule,
  ],
  controllers: [ImporterCreatorController, ImporterAdminController],
  providers: [
    ImportSourcesService,
    ImportRunsService,
    ImportEngineService,
    ImportWorkerService,
    ImporterRetentionTask,
    importerHtmlSanitizerProvider,
    {
      provide: PERSONALIZATION_PRESET_PORT,
      useClass: PersonalizationPresetPortAdapter,
    },
    {
      provide: DESIGNER_IMPORT_PORT,
      useFactory: (real?: NppDesignerImportPort): DesignerImportPort =>
        real ?? new NullDesignerImportPort(),
      inject: [{ token: NppDesignerImportPort, optional: true }],
    },
  ],
})
export class ImporterModule {}
