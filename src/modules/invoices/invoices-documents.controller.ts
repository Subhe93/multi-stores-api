import {
  Controller,
  Get,
  Param,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { InvoicesService } from './invoices.service';

/**
 * Document reads for any signed-in role (customer account page, creator and
 * admin order pages). Ownership follows the order-read rules and is checked
 * in the service; a foreign order or document answers 404 INVOICE_NOT_FOUND.
 */
@Controller('invoices/documents')
@UseGuards(AuthGuard('jwt'))
export class InvoicesDocumentsController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('orders/:orderId')
  forOrder(
    @CurrentUser() user: RequestUser,
    @Param('orderId') orderId: string,
  ) {
    return this.invoices.findForOrder(orderId, user);
  }

  @Get(':id/pdf')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async pdf(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const { buffer, filename } = await this.invoices.pdfForUser(id, user);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
      length: buffer.length,
    });
  }
}
