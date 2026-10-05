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
import { CustomFieldsService } from './custom-fields.service';
import {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
} from './dto/custom-field.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller()
export class CustomFieldsController {
  constructor(private customFieldsService: CustomFieldsService) {}

  @Post('products/:productId/custom-fields')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  create(
    @Param('productId') productId: string,
    @Body() dto: CreateCustomFieldDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.customFieldsService.create(productId, dto, userId, userRole);
  }

  // Public — needed by storefront to render the form
  @Get('products/:productId/custom-fields')
  findByProduct(@Param('productId') productId: string) {
    return this.customFieldsService.findByProduct(productId);
  }

  @Put('custom-fields/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomFieldDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.customFieldsService.update(id, dto, userId, userRole);
  }

  @Delete('custom-fields/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  delete(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.customFieldsService.delete(id, userId, userRole);
  }

  @Put('products/:productId/custom-fields/sort')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  reorder(
    @Param('productId') productId: string,
    @Body('field_ids') fieldIds: string[],
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.customFieldsService.reorder(
      productId,
      fieldIds,
      userId,
      userRole,
    );
  }
}
