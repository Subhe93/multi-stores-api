import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole, ProductStatus } from '@prisma/client';

@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  // عام — تصفح المنتجات
  @Get()
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('category_id') category_id?: string,
    @Query('product_type') product_type?: string,
    @Query('status') status?: ProductStatus,
    @Query('provider_id') provider_id?: string,
    @Query('creator_id') creator_id?: string,
    @Query('owner_type') owner_type?: 'provider' | 'creator',
    @Query('search') search?: string,
    @Query('is_featured') is_featured?: string,
  ) {
    return this.productsService.findAll({
      page: page ? +page : undefined,
      limit: limit ? +limit : undefined,
      category_id,
      product_type,
      status,
      provider_id,
      creator_id,
      owner_type,
      search,
      is_featured: is_featured === 'true' ? true : undefined,
    });
  }

  @Get(':id/import-details')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  getImportDetails(@Param('id') id: string) {
    return this.productsService.getImportDetails(id);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.productsService.findById(id);
  }

  // Provider أو Creator — إنشاء منتج
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
    @Body() dto: CreateProductDto,
  ) {
    return this.productsService.create(userId, userRole, dto);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(id, userId, userRole, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  delete(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.productsService.delete(id, userId, userRole);
  }

  @Post(':id/duplicate')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  duplicate(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.productsService.duplicate(id, userId, userRole);
  }

  @Put(':id/status')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: ProductStatus,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.productsService.updateStatus(id, status, userId, userRole);
  }

  // Images
  @Post(':id/images')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  addImage(
    @Param('id') id: string,
    @Body() body: { url: string; alt_text?: string; sort_order?: number; is_featured?: boolean; variant_id?: string },
  ) {
    return this.productsService.addImage(id, body.url, body.alt_text, body.sort_order, body.is_featured, body.variant_id);
  }

  @Get(':id/images')
  getImages(@Param('id') id: string) {
    return this.productsService.getImages(id);
  }

  @Delete('images/:imageId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  deleteImage(@Param('imageId') imageId: string) {
    return this.productsService.deleteImage(imageId);
  }

  @Put(':id/images/reorder')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  reorderImages(
    @Param('id') id: string,
    @Body('image_ids') imageIds: string[],
  ) {
    return this.productsService.reorderImages(id, imageIds);
  }
}
