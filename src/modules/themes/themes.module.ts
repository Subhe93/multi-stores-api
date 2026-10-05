import { Module } from '@nestjs/common';
import { PagesV2Module } from '../pages-v2/pages-v2.module';
import { ThemesController } from './themes.controller';
import { ThemesService } from './themes.service';

@Module({
  imports: [PagesV2Module],
  controllers: [ThemesController],
  providers: [ThemesService],
  exports: [ThemesService],
})
export class ThemesModule {}
