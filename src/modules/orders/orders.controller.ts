import {
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
  Headers,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OrdersService } from './orders.service';
import {
  BulkOrderIdsDto,
  CreateOrderDto,
  DeleteOrderDto,
  SetOrderTestFlagDto,
  UpdateOrderStatusDto,
  UpdateFulfillmentDto,
} from './dto/order.dto';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrderStatus, UserRole } from '@prisma/client';
import {
  STOREFRONT_VIEWER_HEADER,
  StorefrontGateService,
} from '../storefront/storefront-gate.service';
import { ReqMeta, type RequestMeta } from '../security/request-meta';

/** `?deleted=1|true` of GET /orders (order trash, M69). */
function parseDeletedFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(
    private ordersService: OrdersService,
    private gate: StorefrontGateService,
  ) {}

  // Customer — إنشاء طلب من السلة
  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.CUSTOMER)
  // Optional `X-Storefront-Viewer: Bearer <token>` (FIXES-1 item 4): on a
  // store that is not LIVE the owner / an admin may place a Stripe order
  // paid through the store's TEST own key (created with is_test).
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateOrderDto,
    @Headers(STOREFRONT_VIEWER_HEADER) viewerHeader?: string,
  ) {
    const preLiveViewer = this.gate.preLiveCheck(viewerHeader);
    return this.ordersService.create(
      userId,
      dto,
      preLiveViewer ? { preLiveViewer } : {},
    );
  }

  // Customer — طلباتي
  @Get('my')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CUSTOMER)
  findMyOrders(
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.ordersService.findByCustomer(
      userId,
      page ? +page : undefined,
      limit ? +limit : undefined,
    );
  }

  // All orders — Admin sees all, Provider/Creator sees their own
  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.PROVIDER, UserRole.CREATOR)
  async findAll(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    // Markets app: only orders placed in this market (key).
    @Query('market') market?: string,
    // b2b app: 'company' | 'person' (anything else is ignored).
    @Query('buyer') buyer?: string,
    // Production app (creators only): 'in_production' | 'ready' |
    // 'not_started'; ignored for other values, roles and stores without it.
    @Query('production') production?: string,
    // Order trash (M69): `1` / `true` = only trashed orders (the Deleted
    // tab, creators and admins); absent / `0` = live orders only.
    @Query('deleted') deleted?: string,
  ) {
    // Validate the optional status filter against the OrderStatus enum so an
    // unknown value gets a friendly 400 instead of a database error.
    let statusFilter: OrderStatus | undefined;
    if (status) {
      if (!Object.values(OrderStatus).includes(status as OrderStatus)) {
        throw new BadRequestException({
          code: 'ORDER_INVALID_STATUS_FILTER',
          message: `"${status}" is not a valid order status. Allowed values: ${Object.values(OrderStatus).join(', ')}.`,
        });
      }
      statusFilter = status as OrderStatus;
    }
    const onlyDeleted = parseDeletedFlag(deleted);
    // A provider never sees trashed orders: say so instead of silently
    // answering the live list.
    if (onlyDeleted && role === UserRole.PROVIDER) {
      throw new ForbiddenException({
        code: 'ORDER_TRASH_FORBIDDEN',
        message: 'Only the store owner or an admin can list deleted orders.',
      });
    }

    if (role === UserRole.ADMIN) {
      return this.ordersService.findAll(
        page ? +page : undefined,
        limit ? +limit : undefined,
        statusFilter,
        market || undefined,
        buyer || undefined,
        onlyDeleted,
      );
    }
    // Provider/Creator — find relevant orders
    return this.ordersService.findByRole(
      userId,
      role,
      page ? +page : undefined,
      limit ? +limit : undefined,
      statusFilter,
      market || undefined,
      buyer || undefined,
      production || undefined,
      onlyDeleted,
    );
  }

  // Provider/Creator — الطلبات الواردة
  @Get('fulfiller/:fulfillerId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  findByFulfiller(
    @Param('fulfillerId') fulfillerId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.ordersService.findByFulfiller(
      fulfillerId,
      userId,
      role,
      page ? +page : undefined,
      limit ? +limit : undefined,
    );
  }

  // ── Order trash (M69) ─────────────────────────────────────────────────────
  // The `bulk/*` routes are declared before every `:id` route so "bulk" is
  // never read as an order id.

  // Creator (own store) / Admin — trash several orders; one transaction per
  // order, non-deletable ones are reported in `skipped`.
  @Post('bulk/delete')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  bulkDelete(
    @Body() dto: BulkOrderIdsDto,
    @CurrentUser() user: RequestUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.ordersService.bulkDeleteOrders(dto.ids, user, dto.reason, meta);
  }

  // Creator (own store) / Admin — restore several trashed orders.
  @Post('bulk/restore')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  bulkRestore(
    @Body() dto: BulkOrderIdsDto,
    @CurrentUser() user: RequestUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.ordersService.bulkRestoreOrders(dto.ids, user, meta);
  }

  @Get(':id')
  findById(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.ordersService.findById(id, userId, role);
  }

  // Creator (own store) / Admin — soft delete (409 ORDER_NOT_DELETABLE for
  // a paid / invoiced / paid-out real order).
  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  deleteOrder(
    @Param('id') id: string,
    @Body() dto: DeleteOrderDto,
    @CurrentUser() user: RequestUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.ordersService.deleteOrder(id, user, dto?.reason, meta);
  }

  // Creator (own store) / Admin — restore a trashed order.
  @Post(':id/restore')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  restoreOrder(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.ordersService.restoreOrder(id, user, meta);
  }

  // Admin — mark an order as test (leaves the statistics, becomes
  // deletable) or remove the flag again.
  @Put(':id/test-flag')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  setTestFlag(
    @Param('id') id: string,
    @Body() dto: SetOrderTestFlagDto,
    @CurrentUser() user: RequestUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.ordersService.setTestFlag(id, dto.is_test, user, meta);
  }

  // Provider/Creator/Admin — تحديث حالة الطلب
  @Put(':id/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.ordersService.updateStatus(id, dto, userId, userRole);
  }

  // Provider/Creator — تحديث حالة التنفيذ لعنصر
  @Put(':orderId/items/:itemId/fulfillment')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  updateFulfillment(
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateFulfillmentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.ordersService.updateFulfillment(
      orderId,
      itemId,
      dto,
      userId,
      userRole,
    );
  }
}
