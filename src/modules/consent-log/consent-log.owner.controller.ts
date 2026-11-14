import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Readable } from 'stream';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StoresService } from '../stores/stores.service';
import {
  ConsentLogSummaryQueryDto,
  ExportConsentLogQueryDto,
  ListConsentLogQueryDto,
} from './dto/consent-log.dto';
import {
  CONSENT_SUMMARY_DEFAULT_DAYS,
  ConsentLogService,
} from './consent-log.service';

/** File-name safe part of a query date ("2026-11-14T10:00:00Z" -> "2026-11-14T100000Z"). */
function fileDate(v: string): string {
  return v.replace(/[^0-9A-Za-z-]/g, '');
}

/**
 * Creator dashboard (Settings > Tracking): the consent log of the caller's
 * own store. The store always comes from the JWT; an owner can never pass a
 * store id. `ip_prefix` / `ua_hash` are never returned.
 */
@Controller('stores/my/consent-log')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class ConsentLogOwnerController {
  constructor(
    private readonly consentLog: ConsentLogService,
    private readonly stores: StoresService,
  ) {}

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: ListConsentLogQueryDto,
  ) {
    const storeId = await this.stores.findStoreIdByCreatorUser(userId);
    return this.consentLog.list(storeId, query);
  }

  @Get('summary')
  async summary(
    @CurrentUser('id') userId: string,
    @Query() query: ConsentLogSummaryQueryDto,
  ) {
    const storeId = await this.stores.findStoreIdByCreatorUser(userId);
    return this.consentLog.summary(
      storeId,
      query.days ?? CONSENT_SUMMARY_DEFAULT_DAYS,
    );
  }

  /** CSV of a window (max 366 days, 100,000 rows), streamed in pages of 1,000. */
  @Get('export')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async export(
    @CurrentUser('id') userId: string,
    @Query() query: ExportConsentLogQueryDto,
  ): Promise<StreamableFile> {
    const storeId = await this.stores.findStoreIdByCreatorUser(userId);
    const range = this.consentLog.exportRange(query);
    const slug = await this.consentLog.storeSlug(storeId);
    const consentLog = this.consentLog;
    async function* body(): AsyncGenerator<Buffer> {
      // BOM so Excel opens the UTF-8 file correctly.
      yield Buffer.from('﻿', 'utf8');
      for await (const chunk of consentLog.exportCsv(storeId, range)) {
        yield Buffer.from(chunk, 'utf8');
      }
    }
    return new StreamableFile(Readable.from(body()), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="consent-log-${slug}-${fileDate(query.from)}-${fileDate(query.to)}.csv"`,
    });
  }
}
