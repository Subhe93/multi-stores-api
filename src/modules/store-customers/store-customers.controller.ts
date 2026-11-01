import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { csvFile } from '../invoices/invoices-creator.controller';
import { StoreCustomersService } from './store-customers.service';
import {
  BulkCustomersDto,
  CreateStoreCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerStatusDto,
  UpdateStoreCustomerDto,
} from './dto/store-customers.dto';

/**
 * Creator dashboard: customers of the caller's own store (the store always
 * comes from the JWT; marketplace stores included). Providers and customers
 * get 403 from the RolesGuard. A customer id of another store is 404
 * CUSTOMER_NOT_FOUND. Static paths (export.csv, bulk) are declared before
 * `:id` so they are never taken for an id.
 */
@Controller('stores/my/customers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class StoreCustomersController {
  constructor(private readonly customers: StoreCustomersService) {}

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: ListCustomersQueryDto,
  ) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.list(store, query);
  }

  /** Same filters and sort as the list; every matching row. */
  @Get('export.csv')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async exportCsv(
    @CurrentUser('id') userId: string,
    @Query() query: ListCustomersQueryDto,
  ) {
    const store = await this.customers.storeForCreator(userId);
    const csv = await this.customers.exportCsv(store, query);
    const day = new Date().toISOString().slice(0, 10);
    return csvFile(csv, `customers-${store.slug}-${day}.csv`);
  }

  @Post('bulk')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async bulk(@CurrentUser('id') userId: string, @Body() dto: BulkCustomersDto) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.bulk(store, dto);
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStoreCustomerDto,
  ) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.create(store, dto);
  }

  @Get(':id')
  async detail(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.detail(store, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStoreCustomerDto,
  ) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.update(store, id, dto);
  }

  @Patch(':id/status')
  async setStatus(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerStatusDto,
  ) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.setStatus(store, id, dto.status);
  }

  @Post(':id/send-login-link')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async sendLoginLink(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.sendLoginLink(store, id);
  }

  @Post(':id/send-password-reset')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async sendPasswordReset(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const store = await this.customers.storeForCreator(userId);
    return this.customers.sendPasswordReset(store, id);
  }
}
