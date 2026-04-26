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
import { AttributesService } from './attributes.service';
import {
  CreateAttributeTemplateDto,
  UpdateAttributeTemplateDto,
} from './dto/attribute.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('attribute-templates')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AttributesController {
  constructor(private attributesService: AttributesService) {}

  @Post()
  create(@Body() dto: CreateAttributeTemplateDto) {
    return this.attributesService.create(dto);
  }

  @Get()
  findAll() {
    return this.attributesService.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.attributesService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAttributeTemplateDto) {
    return this.attributesService.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.attributesService.delete(id);
  }
}
