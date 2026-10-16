import { Module } from '@nestjs/common';
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
 */
@Module({
  imports: [
    DesignerAssetsModule,
    DesignerCoreModule,
    DesignerImportModule,
    DesignerRenderModule,
    DesignerRetentionModule,
  ],
  exports: [
    DesignerAssetsModule,
    DesignerCoreModule,
    DesignerImportModule,
    DesignerRenderModule,
  ],
})
export class DesignerModule {}
