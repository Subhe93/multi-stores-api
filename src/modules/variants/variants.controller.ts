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
import { VariantsService } from './variants.service';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
export class VariantsController {
  constructor(private variantsService: VariantsService) {}

  @Post('products/:productId/variants')
  create(
    @Param('productId') productId: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.variantsService.create(productId, dto);
  }

  @Get('products/:productId/variants')
  findByProduct(@Param('productId') productId: string) {
    return this.variantsService.findByProduct(productId);
  }

  @Get('variants/:id')
  findById(@Param('id') id: string) {
    return this.variantsService.findById(id);
  }

  @Put('variants/:id')
  update(@Param('id') id: string, @Body() dto: UpdateVariantDto) {
    return this.variantsService.update(id, dto);
  }

  @Delete('variants/:id')
  delete(@Param('id') id: string) {
    return this.variantsService.delete(id);
  }

  @Put('variants/:id/stock')
  updateStock(
    @Param('id') id: string,
    @Body('quantity') quantity: number,
  ) {
    return this.variantsService.updateStock(id, quantity);
  }
}
