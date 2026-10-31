import { Module } from '@nestjs/common';
import { RedirectsModule } from '../redirects/redirects.module';
import { CreatorCategoriesController } from './creator-categories.controller';
import { CreatorCategoriesService } from './creator-categories.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [RedirectsModule, PrismaModule],
  controllers: [CreatorCategoriesController],
  providers: [CreatorCategoriesService],
  exports: [CreatorCategoriesService],
})
export class CreatorCategoriesModule {}
