import { Module } from '@nestjs/common';
import { InvoicesCreatorController } from './invoices-creator.controller';
import { InvoicesDocumentsController } from './invoices-documents.controller';
import { InvoicesAdminController } from './invoices-admin.controller';
import { InvoicesService } from './invoices.service';
import { InvoiceTriggersService } from './invoice-triggers.service';
import { InvoiceNumberingService } from './invoice-numbering.service';
import { LegalProfileService } from './legal-profile.service';
import { InvoicesMailExtension } from './invoices-mail.extension';
import { INVOICE_PDF_PROVIDERS } from './pdf';

// Invoices app (M3). Imports nothing: Prisma, StoreApps, Mail and Config are
// global, so OrdersModule and PaymentsModule can import this module for
// InvoiceTriggersService without a cycle (D5).
@Module({
  controllers: [
    InvoicesCreatorController,
    InvoicesDocumentsController,
    InvoicesAdminController,
  ],
  providers: [
    LegalProfileService,
    InvoiceNumberingService,
    InvoicesService,
    InvoiceTriggersService,
    // Registers itself with MailService (order email vars + PDF attachments).
    InvoicesMailExtension,
    ...INVOICE_PDF_PROVIDERS,
  ],
  exports: [InvoiceTriggersService, InvoicesService],
})
export class InvoicesModule {}
