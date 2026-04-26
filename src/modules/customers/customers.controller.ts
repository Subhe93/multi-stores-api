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
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CreateAddressDto,
} from './dto/create-customer.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('customers')
@UseGuards(AuthGuard('jwt'))
export class CustomersController {
  constructor(private customersService: CustomersService) {}

  @Post()
  @Roles(UserRole.CUSTOMER)
  @UseGuards(RolesGuard)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateCustomerDto) {
    return this.customersService.create(userId, dto);
  }

  @Get('me')
  @Roles(UserRole.CUSTOMER)
  @UseGuards(RolesGuard)
  getMyProfile(@CurrentUser('id') userId: string) {
    return this.customersService.findByUserId(userId);
  }

  @Put('me')
  @Roles(UserRole.CUSTOMER)
  @UseGuards(RolesGuard)
  updateMyProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(userId, dto);
  }

  // Addresses
  @Post('me/addresses')
  @Roles(UserRole.CUSTOMER)
  @UseGuards(RolesGuard)
  addAddress(@CurrentUser('id') userId: string, @Body() dto: CreateAddressDto) {
    return this.customersService.addAddress(userId, dto);
  }

  @Get('me/addresses')
  @Roles(UserRole.CUSTOMER)
  @UseGuards(RolesGuard)
  getAddresses(@CurrentUser('id') userId: string) {
    return this.customersService.getAddresses(userId);
  }

  @Delete('me/addresses/:id')
  @Roles(UserRole.CUSTOMER)
  @UseGuards(RolesGuard)
  deleteAddress(
    @CurrentUser('id') userId: string,
    @Param('id') addressId: string,
  ) {
    return this.customersService.deleteAddress(userId, addressId);
  }
}
