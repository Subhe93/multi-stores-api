import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PagesV2Service } from './pages-v2.service';
import {
  CreatePageDto,
  CreateSectionDto,
  PublishPageDto,
  ReorderSectionsDto,
  UpdatePageDto,
  UpdateSectionDto,
} from './dto/pages.dto';

@Controller('v2/pages')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class PagesV2Controller {
  constructor(private service: PagesV2Service) {}

  // ── Pages CRUD ───────────────────────────────────────

  @Get('mine')
  list(@CurrentUser('id') userId: string) {
    return this.service.listByStore(userId);
  }

  // Provision the creator's HOME page if missing. Idempotent.
  @Post('mine/home/ensure')
  ensureHome(@CurrentUser('id') userId: string) {
    return this.service.ensureHomePage(userId);
  }

  // Provision the creator's single PRODUCT_TEMPLATE if missing. Idempotent.
  @Post('mine/product-template/ensure')
  ensureProductTemplate(@CurrentUser('id') userId: string) {
    return this.service.ensureProductTemplate(userId);
  }

  // Provision the creator's HEADER singleton if missing. Idempotent.
  @Post('mine/header/ensure')
  ensureHeader(@CurrentUser('id') userId: string) {
    return this.service.ensureHeader(userId);
  }

  // Provision the creator's FOOTER singleton if missing. Idempotent.
  @Post('mine/footer/ensure')
  ensureFooter(@CurrentUser('id') userId: string) {
    return this.service.ensureFooter(userId);
  }

  @Get(':id')
  getById(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.service.getById(userId, id);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreatePageDto) {
    return this.service.create(userId, dto);
  }

  @Put(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePageDto,
  ) {
    return this.service.update(userId, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.service.delete(userId, id);
  }

  // ── Sections ─────────────────────────────────────────

  @Get(':id/sections')
  listSections(@CurrentUser('id') userId: string, @Param('id') pageId: string) {
    return this.service.listSections(userId, pageId);
  }

  @Post(':id/sections')
  addSection(
    @CurrentUser('id') userId: string,
    @Param('id') pageId: string,
    @Body() dto: CreateSectionDto,
  ) {
    return this.service.addSection(userId, pageId, dto);
  }

  @Put('sections/:sectionId')
  updateSection(
    @CurrentUser('id') userId: string,
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateSectionDto,
  ) {
    return this.service.updateSection(userId, sectionId, dto);
  }

  @Delete('sections/:sectionId')
  deleteSection(
    @CurrentUser('id') userId: string,
    @Param('sectionId') sectionId: string,
  ) {
    return this.service.deleteSection(userId, sectionId);
  }

  @Put(':id/sections/sort')
  reorderSections(
    @CurrentUser('id') userId: string,
    @Param('id') pageId: string,
    @Body() dto: ReorderSectionsDto,
  ) {
    return this.service.reorderSections(userId, pageId, dto);
  }

  // ── Publish / versions ───────────────────────────────

  @Post(':id/publish')
  publish(
    @CurrentUser('id') userId: string,
    @Param('id') pageId: string,
    @Body() dto: PublishPageDto,
  ) {
    return this.service.publish(userId, pageId, dto);
  }

  @Get(':id/versions')
  listVersions(
    @CurrentUser('id') userId: string,
    @Param('id') pageId: string,
  ) {
    return this.service.listVersions(userId, pageId);
  }

  // Restore an older version into the live draft. Doesn't auto-publish — the
  // creator reviews the restored draft and chooses when to publish.
  @Post(':id/versions/:versionId/restore')
  restoreVersion(
    @CurrentUser('id') userId: string,
    @Param('id') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.service.restoreVersion(userId, pageId, versionId);
  }
}
