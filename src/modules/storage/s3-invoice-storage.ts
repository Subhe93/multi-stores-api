/**
 * `InvoiceStorage` over `PRIVATE_OBJECT_STORAGE`: today's keys
 * (`<store>/<yyyy>/<invoice>.pdf`) under the prefix `invoices/` in the
 * private bucket. `Invoice.pdf_path` keeps storing the key without the prefix.
 */
import {
  InvalidInvoiceStorageKeyError,
  invoiceKeyFor,
  isValidInvoiceStorageKey,
  type InvoiceStorage,
} from '../invoices/storage/invoice-storage';
import type { ObjectStorage } from './object-storage';
import { collect } from './s3-private-storage';

export const INVOICE_OBJECT_PREFIX = 'invoices/';

export class S3InvoiceStorage implements InvoiceStorage {
  constructor(private readonly objects: ObjectStorage) {}

  keyFor(storeId: string, issueDate: Date | string, invoiceId: string): string {
    return invoiceKeyFor(storeId, issueDate, invoiceId);
  }

  /** The object key of an invoice key (validated). */
  objectKey(key: string): string {
    if (!isValidInvoiceStorageKey(key)) {
      throw new InvalidInvoiceStorageKeyError(String(key));
    }
    return `${INVOICE_OBJECT_PREFIX}${key}`;
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.objects.head(this.objectKey(key));
    return head !== null && head.size > 0;
  }

  async read(key: string): Promise<Buffer | null> {
    const obj = await this.objects.get(this.objectKey(key));
    if (!obj) return null;
    return collect(obj.stream);
  }

  async write(key: string, data: Buffer): Promise<void> {
    await this.objects.put(this.objectKey(key), data, {
      contentType: 'application/pdf',
      cacheControl: 'private, no-store',
      sse: 'kms',
    });
  }
}
