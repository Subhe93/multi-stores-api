import { Module } from '@nestjs/common';
import { ProductFaqsController } from './product-faqs.controller';
import { ProductFaqsService } from './product-faqs.service';

@Module({
  controllers: [ProductFaqsController],
  providers: [ProductFaqsService],
  exports: [ProductFaqsService],
})
export class ProductFaqsModule {}
