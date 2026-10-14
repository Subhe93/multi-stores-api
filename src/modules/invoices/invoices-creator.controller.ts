import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { InvoicesService } from './invoices.service';
import { LegalProfileService } from './legal-profile.service';
import { UpdateLegalProfileDto } from './dto/legal-profile.dto';
import { UpdateNumberingDto } from './dto/numbering.dto';
import { CreditNoteDto } from './dto/credit-note.dto';
import { BacklogQueryDto, InvoiceQueryDto } from './dto/invoice-query.dto';

/** UTF-8 BOM + CSV body as an attachment (passes the envelope interceptor). */
export function csvFile(body: string, name: string): StreamableFile {
  return new StreamableFile(Buffer.from('﻿' + body), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${name}"`,
  });
}

/**
 * Creator routes of the invoices app. Writes (and the backlog) carry
 * @RequireApp('invoices') (403 STORE_APP_NOT_ENABLED when off); the reads
 * (list, CSV, detail, legal profile) stay open whenever documents exist, also after
 * the app is disabled (L1, bookkeeping retention). Static routes are declared
 * before ':id'.
 */
@Controller('invoices/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
export class InvoicesCreatorController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly profiles: LegalProfileService,
  ) {}

  // Read: open without the app too (L1), like the document reads.
  @Get('legal-profile')
  async getProfile(@CurrentUser('id') userId: string) {
    return this.profiles.get(await this.invoices.storeIdForCreator(userId));
  }

  @Put('legal-profile')
  @RequireApp('invoices')
  async putProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateLegalProfileDto,
  ) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    return this.profiles.upsert(storeId, dto);
  }

  @Put('numbering')
  @RequireApp('invoices')
  async putNumbering(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateNumberingDto,
  ) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    return this.profiles.updateNumbering(storeId, dto);
  }

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: InvoiceQueryDto,
  ) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    const filter = { ...query, store_id: undefined };
    if (query.format === 'csv') {
      const csv = await this.invoices.listCsv(storeId, filter);
      return csvFile(
        csv,
        `invoices-${query.from ?? 'all'}-${query.to ?? 'all'}.csv`,
      );
    }
    return this.invoices.list(storeId, filter);
  }

  @Get('backlog')
  @RequireApp('invoices')
  async backlog(
    @CurrentUser('id') userId: string,
    @Query() query: BacklogQueryDto,
  ) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    return this.invoices.backlog(storeId, query.limit);
  }

  @Post('backlog/issue')
  @RequireApp('invoices')
  async issueBacklog(@CurrentUser('id') userId: string) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    return this.invoices.issueBacklog(storeId, userId);
  }

  @Post('orders/:orderId/issue')
  @RequireApp('invoices')
  async issue(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
  ) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    return this.invoices.issueManually(storeId, orderId, userId);
  }

  @Get(':id')
  async detail(@CurrentUser('id') userId: string, @Param('id') id: string) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    return this.invoices.detail(storeId, id);
  }

  @Post(':id/credit-note')
  @RequireApp('invoices')
  async credit(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: CreditNoteDto,
  ) {
    const storeId = await this.invoices.storeIdForCreator(userId);
    return this.invoices.creditManually(storeId, id, dto, userId);
  }
}
