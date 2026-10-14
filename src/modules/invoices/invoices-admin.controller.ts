import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InvoicesService } from './invoices.service';
import { InvoiceQueryDto } from './dto/invoice-query.dto';
import { csvFile } from './invoices-creator.controller';

/** Cross-store document list for the platform admin (always readable). */
@Controller('invoices/admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class InvoicesAdminController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  async list(@Query() query: InvoiceQueryDto) {
    if (query.format === 'csv') {
      const csv = await this.invoices.listCsv(null, query);
      return csvFile(
        csv,
        `invoices-admin-${query.from ?? 'all'}-${query.to ?? 'all'}.csv`,
      );
    }
    return this.invoices.list(null, query);
  }
}
