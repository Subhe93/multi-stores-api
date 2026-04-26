import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ProductFaqsService } from './product-faqs.service';
import { CreateProductFaqDto, UpdateProductFaqDto } from './dto/product-faq.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller()
export class ProductFaqsController {
  constructor(private faqsService: ProductFaqsService) {}

  @Post('products/:productId/faqs')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  create(
    @Param('productId') productId: string,
    @Body() dto: CreateProductFaqDto,
  ) {
    return this.faqsService.create(productId, dto);
  }

  @Get('products/:productId/faqs')
  findByProduct(@Param('productId') productId: string) {
    return this.faqsService.findByProduct(productId);
  }

  @Put('faqs/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateProductFaqDto) {
    return this.faqsService.update(id, dto);
  }

  @Delete('faqs/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  delete(@Param('id') id: string) {
    return this.faqsService.delete(id);
  }

  @Put('products/:productId/faqs/sort')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  reorder(
    @Param('productId') productId: string,
    @Body('faq_ids') faqIds: string[],
  ) {
    return this.faqsService.reorder(productId, faqIds);
  }
}
