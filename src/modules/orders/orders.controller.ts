import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderStatusDto, UpdateFulfillmentDto } from './dto/order.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  // Customer — إنشاء طلب من السلة
  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.CUSTOMER)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(userId, dto);
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
    return this.ordersService.findByCustomer(userId, page ? +page : undefined, limit ? +limit : undefined);
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
  ) {
    if (role === UserRole.ADMIN) {
      return this.ordersService.findAll(page ? +page : undefined, limit ? +limit : undefined);
    }
    // Provider/Creator — find relevant orders
    return this.ordersService.findByRole(userId, role, page ? +page : undefined, limit ? +limit : undefined);
  }

  // Provider/Creator — الطلبات الواردة
  @Get('fulfiller/:fulfillerId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  findByFulfiller(
    @Param('fulfillerId') fulfillerId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.ordersService.findByFulfiller(fulfillerId, page ? +page : undefined, limit ? +limit : undefined);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.ordersService.findById(id);
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
    return this.ordersService.updateFulfillment(orderId, itemId, dto, userId, userRole);
  }
}
