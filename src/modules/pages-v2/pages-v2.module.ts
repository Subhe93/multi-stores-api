import { Module } from '@nestjs/common';
import { RedirectsModule } from '../redirects/redirects.module';
import { PagesV2Controller } from './pages-v2.controller';
import { PagesV2Service } from './pages-v2.service';

@Module({
  imports: [RedirectsModule],
  controllers: [PagesV2Controller],
  providers: [PagesV2Service],
  exports: [PagesV2Service],
})
export class PagesV2Module {}
