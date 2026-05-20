import { Module } from '@nestjs/common';
import { PagesV2Controller } from './pages-v2.controller';
import { PagesV2Service } from './pages-v2.service';

@Module({
  controllers: [PagesV2Controller],
  providers: [PagesV2Service],
  exports: [PagesV2Service],
})
export class PagesV2Module {}
