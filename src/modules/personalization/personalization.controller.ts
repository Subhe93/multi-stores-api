import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StoreAppsService } from '../store-apps/store-apps.service';
import {
  ApplyPresetDto,
  CreateTemplateDto,
  UpdateTemplateDto,
} from './dto/personalization.dto';
import { PersonalizationLibraryService } from './personalization-library.service';
import { PersonalizationPresetsService } from './personalization-presets.service';

/**
 * Creator routes of the personalization app (M4.1 §4.4, `/my` convention
 * C33). The store is the creator's own; products must be theirs.
 */
@Controller('personalization/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('personalization')
export class PersonalizationController {
  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly presets: PersonalizationPresetsService,
    private readonly library: PersonalizationLibraryService,
  ) {}

  @Get('presets')
  listPresets() {
    return this.presets.list();
  }

  /** → the created fields (top level, children nested). */
  @Post('products/:productId/presets/:key')
  async applyPreset(
    @CurrentUser('id') userId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('key') key: string,
    @Body() dto: ApplyPresetDto,
  ) {
    const result = await this.presets.apply(
      productId,
      key,
      dto.params ?? {},
      { mode: dto.mode ?? 'append' },
      { userId, role: UserRole.CREATOR },
    );
    return result.fields;
  }

  @Get('library')
  async listLibrary(@CurrentUser('id') userId: string) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.library.list(store.id);
  }

  @Post('library')
  async createTemplate(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTemplateDto,
  ) {
    if (!!dto.from_field_id === (dto.definition !== undefined)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Send exactly one of from_field_id or definition',
      });
    }
    const store = await this.storeApps.storeOfCreator(userId);
    return this.library.create(store.id, userId, dto);
  }

  @Put('library/:id')
  async updateTemplate(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.library.update(store.id, id, dto);
  }

  @Delete('library/:id')
  async deleteTemplate(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.library.remove(store.id, id);
  }

  /** → the inserted fields (top level, children nested). */
  @Post('products/:productId/library/:id')
  async insertTemplate(
    @CurrentUser('id') userId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.library.insertIntoProduct(store.id, userId, id, productId);
  }
}
