import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StoreCustomersService } from './store-customers.service';
import {
  AdminCreateCustomerDto,
  AdminListCustomersQueryDto,
} from './dto/store-customers.dto';

/** Platform-wide customers list for the admin (every row names its store). */
@Controller('admin/customers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminCustomersController {
  constructor(private readonly customers: StoreCustomersService) {}

  @Get()
  list(@Query() query: AdminListCustomersQueryDto) {
    return this.customers.adminList(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.adminDetail(id);
  }

  /** A customer always belongs to a store: `store_id` is required. */
  @Post()
  async create(@Body() dto: AdminCreateCustomerDto) {
    const { store_id, ...rest } = dto;
    const store = await this.customers.storeById(store_id);
    // The per-store daily email cap applies to store owners only.
    return this.customers.create(store, rest, { enforceDailyLimit: false });
  }
}
