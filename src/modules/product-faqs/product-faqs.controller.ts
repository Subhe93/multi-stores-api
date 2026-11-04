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
import {
  CreateProductFaqDto,
  UpdateProductFaqDto,
} from './dto/product-faq.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
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
    @CurrentUser() user: RequestUser,
  ) {
    return this.faqsService.create(productId, dto, user);
  }

  @Get('products/:productId/faqs')
  findByProduct(@Param('productId') productId: string) {
    return this.faqsService.findByProduct(productId);
  }

  @Put('faqs/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductFaqDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.faqsService.update(id, dto, user);
  }

  @Delete('faqs/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  delete(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.faqsService.delete(id, user);
  }

  @Put('products/:productId/faqs/sort')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  reorder(
    @Param('productId') productId: string,
    @Body('faq_ids') faqIds: string[],
    @CurrentUser() user: RequestUser,
  ) {
    return this.faqsService.reorder(productId, faqIds, user);
  }
}
