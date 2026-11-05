import {
  Controller,
  Get,
  Param,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InvoicesService } from './invoices.service';
import { ProviderInvoiceQueryDto } from './dto/invoice-query.dto';

/**
 * Provider read of the documents the stores issued for orders containing
 * items it fulfils. Read-only and app-agnostic (L1: documents stay readable
 * whenever they exist). Providers never get the tax invoice itself: the
 * list and the PDF are SUPPLIER COPIES showing only the provider's own
 * lines (GET /invoices/documents/:id/pdf refuses PROVIDER).
 */
@Controller('invoices/provider')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.PROVIDER)
export class InvoicesProviderController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  list(
    @CurrentUser('id') userId: string,
    @Query() query: ProviderInvoiceQueryDto,
  ) {
    return this.invoices.listForProvider(userId, query);
  }

  @Get(':id/pdf')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async pdf(@CurrentUser('id') userId: string, @Param('id') id: string) {
    const { buffer, filename } = await this.invoices.supplierCopyPdf(
      id,
      userId,
    );
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
      length: buffer.length,
    });
  }
}
