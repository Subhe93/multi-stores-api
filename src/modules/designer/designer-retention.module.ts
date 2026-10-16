import { Module } from '@nestjs/common';
import { DesignerAssetsModule } from './designer-assets.module';
import { DesignerMailExtension } from './designer-mail.extension';
import { DesignerRenderModule } from './designer-render.module';
import { DesignerRetentionController } from './designer-retention.controller';
import { DesignerRetentionService } from './designer-retention.service';

/**
 * Retention (WP6: the `designer.*` tasks of the global RetentionModule plus
 * the R5 erasure route) and the order-email extension (WP10) of the
 * designer app. Imports only the cycle-free asset and render modules;
 * RetentionService and MailService are global.
 */
@Module({
  imports: [DesignerAssetsModule, DesignerRenderModule],
  controllers: [DesignerRetentionController],
  providers: [DesignerRetentionService, DesignerMailExtension],
  exports: [DesignerRetentionService],
})
export class DesignerRetentionModule {}
