import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InvoicesService } from './invoices.service';
import { ProviderInvoiceQueryDto } from './dto/invoice-query.dto';

/**
 * Provider read of the documents the stores issued for orders containing
 * items it fulfils. Read-only and app-agnostic (L1: documents stay readable
 * whenever they exist). PDFs go through GET /invoices/documents/:id/pdf,
 * which already authorises providers per order.
 */
@Controller('invoices/provider')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.PROVIDER)
export class InvoicesProviderController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query() query: ProviderInvoiceQueryDto,
  ) {
    return this.invoices.listForProvider(userId, query);
  }
}
