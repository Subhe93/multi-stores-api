import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { OrdersService } from '../orders/orders.service';
import {
  ProductionChecklistService,
  type ProductionWriteResult,
} from './production-checklist.service';
import { ProductionAutomationService } from './production-automation.service';
import {
  DEFAULT_PRODUCTION_SETTINGS,
  PRODUCTION_PRESETS,
} from './production-settings';
import {
  buildWorkspace,
  toCheckView,
  type WorkspaceOrderSource,
} from './production-workspace';
import {
  AddCustomCheckDto,
  BulkCheckDto,
  EventsQueryDto,
  SetCheckDto,
  SummariesQueryDto,
} from './dto/production.dto';

/**
 * Creator routes of the production app (M4.3 §3.7). The store owner (who is
 * also the fulfiller of the store's own lines) is the only actor: the store
 * comes from the JWT, every order / check is checked against it (404 for a
 * foreign id), and lines fulfilled by a provider are read-only (403). The
 * whole controller answers 403 STORE_APP_NOT_ENABLED without the app.
 */
@Controller('production/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('production')
export class ProductionController {
  constructor(
    private readonly checklist: ProductionChecklistService,
    private readonly automation: ProductionAutomationService,
    private readonly orders: OrdersService,
  ) {}

  /** Effective settings (defaults merged) and the named presets. */
  @Get('settings')
  async settings(@CurrentUser('id') userId: string) {
    const ctx = await this.checklist.contextOf(userId);
    return {
      settings: await this.automation.settingsOf(ctx.storeId),
      defaults: DEFAULT_PRODUCTION_SETTINGS,
      presets: PRODUCTION_PRESETS,
    };
  }

  @Get('summaries')
  async summaries(
    @CurrentUser('id') userId: string,
    @Query() query: SummariesQueryDto,
  ) {
    const ctx = await this.checklist.contextOf(userId);
    return this.checklist.summaries(ctx.storeId, query.order_ids);
  }

  @Post('backfill')
  async backfill(@CurrentUser('id') userId: string) {
    const ctx = await this.checklist.contextOf(userId);
    return this.checklist.backfill(ctx.storeId);
  }

  /** Workspace / print sheet: syncs the checklist first (lazy repair). */
  @Get('orders/:orderId')
  async workspace(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
  ) {
    const ctx = await this.checklist.contextOf(userId);
    await this.checklist.syncOrder(orderId, ctx.storeId);
    // An owed auto-advance (sync-driven READY, or a failed updateStatus)
    // runs here before the order is read.
    await this.automation.retryPending(ctx, orderId);
    const order = (await this.orders.findById(
      orderId,
      userId,
      UserRole.CREATOR,
    )) as unknown as WorkspaceOrderSource;
    const [{ checks, summary }, settings, printFiles, autoAdvanced] =
      await Promise.all([
        this.checklist.orderState(orderId),
        this.automation.settingsOf(ctx.storeId),
        this.checklist.printFiles(orderId),
        this.checklist.lastAutoAdvance(orderId),
      ]);
    return {
      ...buildWorkspace({
        order,
        checks,
        summary,
        suggestion: this.automation.suggestionFor(
          settings,
          order.status as never,
          summary,
        ),
        settings,
        creatorId: ctx.creatorId,
        primaryLocale: ctx.primaryLocale,
        printFiles,
      }),
      // M5.4: the latest automation move (print-ready notice).
      auto_advanced: autoAdvanced,
    };
  }

  /** Audit log page (`?page=1&limit=50`, limit at most 200), newest first. */
  @Get('orders/:orderId/events')
  async events(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
    @Query() query: EventsQueryDto,
  ) {
    const ctx = await this.checklist.contextOf(userId);
    return this.checklist.events(ctx.storeId, orderId, {
      page: query.page,
      limit: query.limit,
    });
  }

  @Put('checks/:checkId')
  async setCheck(
    @CurrentUser('id') userId: string,
    @Param('checkId') checkId: string,
    @Body() dto: SetCheckDto,
  ) {
    const ctx = await this.checklist.contextOf(userId);
    const result = await this.checklist.setDone(
      ctx.storeId,
      checkId,
      dto.done,
      ctx.actor,
    );
    const orderId = result.check?.order_id;
    return this.respond(ctx, orderId ?? null, result);
  }

  @Post('orders/:orderId/bulk')
  async bulk(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
    @Body() dto: BulkCheckDto,
  ) {
    const ctx = await this.checklist.contextOf(userId);
    const result = await this.checklist.bulkSet(
      ctx.storeId,
      orderId,
      dto.order_item_id ?? null,
      dto.done,
      ctx.actor,
    );
    return this.respond(ctx, orderId, result);
  }

  @Post('orders/:orderId/items/:itemId/checks')
  async addCustom(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @Body() dto: AddCustomCheckDto,
  ) {
    const ctx = await this.checklist.contextOf(userId);
    const check = await this.checklist.addCustom(
      ctx.storeId,
      orderId,
      itemId,
      dto.label,
      ctx.actor,
    );
    return toCheckView(check);
  }

  @Delete('checks/:checkId')
  @HttpCode(204)
  async removeCustom(
    @CurrentUser('id') userId: string,
    @Param('checkId') checkId: string,
  ): Promise<void> {
    const ctx = await this.checklist.contextOf(userId);
    await this.checklist.removeCustom(ctx.storeId, checkId, ctx.actor);
  }

  private async respond(
    ctx: Awaited<ReturnType<ProductionChecklistService['contextOf']>>,
    orderId: string | null,
    result: ProductionWriteResult,
  ) {
    const automation = orderId
      ? await this.automation.afterWrite(ctx, orderId, result)
      : { suggestion: null, order_status: null };
    return {
      check: result.check ? toCheckView(result.check) : null,
      summary: result.summary,
      changed: result.changed,
      ...automation,
    };
  }
}
