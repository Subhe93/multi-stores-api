import { Module, type OnModuleInit } from '@nestjs/common';
import { ProductionChecklistService } from '../production/production-checklist.service';
import { ProductionCoreModule } from '../production/production-core.module';
import { DesignProductionProvider } from '../production/production-design.provider';
import { DesignerAssetsModule } from './designer-assets.module';
import { DesignerCoreModule } from './designer-core.module';
import { DesignerRenderModule } from './designer-render.module';
import { DesignerRetentionModule } from './designer-retention.module';
import { DesignerImportModule } from './npp/designer-import.module';

/**
 * Designer store app (M4.2). P3 step 0 + WP3: storage, template assets,
 * fonts and signed links. WP4 (designs + commerce, `DesignerCoreModule`),
 * WP5 (render + queue + triggers), WP7 (NPP import + `DesignerImportPort`),
 * WP6 (retention tasks + R5 erasure) and WP10 (order-email proof image,
 * `DesignerRetentionModule`) add their modules/providers here.
 *
 * C27: on init the designer registers its production source provider, so
 * a designed order line gets a `design:<id>` "Print file" check and the
 * production sheet lists the print files. `ProductionCoreModule` imports
 * nothing, so this adds no cycle; the provider itself is a no-op for stores
 * without the designer app.
 */
@Module({
  imports: [
    DesignerAssetsModule,
    DesignerCoreModule,
    DesignerImportModule,
    DesignerRenderModule,
    DesignerRetentionModule,
    ProductionCoreModule,
  ],
  exports: [
    DesignerAssetsModule,
    DesignerCoreModule,
    DesignerImportModule,
    DesignerRenderModule,
  ],
})
export class DesignerModule implements OnModuleInit {
  constructor(
    private readonly checklist: ProductionChecklistService,
    private readonly provider: DesignProductionProvider,
  ) {}

  onModuleInit(): void {
    this.checklist.registerProvider(this.provider);
  }
}
