/**
 * Private storage for rendered invoice PDFs (D8).
 *
 * Never under `uploads/` (served publicly by main.ts). Keys are
 * `<store_id>/<yyyy>/<invoice_id>.pdf`; writes are atomic (temp file in the
 * same directory + rename) so a crash never leaves a truncated PDF behind,
 * and every key is validated and resolved inside the root so a crafted id can
 * never escape it.
 */
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export const INVOICE_STORAGE = Symbol('INVOICE_STORAGE');

export interface InvoiceStorage {
  /** Storage key for an invoice PDF: `<store_id>/<yyyy>/<invoice_id>.pdf`. */
  keyFor(storeId: string, issueDate: Date | string, invoiceId: string): string;
  exists(key: string): Promise<boolean>;
  /** File contents, or null when the file does not exist. */
  read(key: string): Promise<Buffer | null>;
  /** Atomically writes (or replaces) the file. */
  write(key: string, data: Buffer): Promise<void>;
}

export class InvalidInvoiceStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid invoice storage key: ${JSON.stringify(key)}`);
    this.name = 'InvalidInvoiceStorageKeyError';
  }
}

// ids are uuids / cuid-like tokens; nothing that could form a path.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY =
  /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(\d{4})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.pdf$/;

export function defaultInvoiceStorageDir(): string {
  return path.join(process.cwd(), 'storage', 'invoices');
}

export class LocalDiskInvoiceStorage implements InvoiceStorage {
  readonly root: string;

  constructor(root?: string | null) {
    this.root = path.resolve(
      root && root.trim() ? root.trim() : defaultInvoiceStorageDir(),
    );
  }

  keyFor(storeId: string, issueDate: Date | string, invoiceId: string): string {
    if (!SEGMENT.test(storeId) || !SEGMENT.test(invoiceId)) {
      throw new InvalidInvoiceStorageKeyError(`${storeId}/${invoiceId}`);
    }
    const d =
      issueDate instanceof Date ? issueDate : new Date(String(issueDate));
    const year = Number.isNaN(d.getTime())
      ? String(issueDate).slice(0, 4)
      : String(d.getUTCFullYear());
    if (!/^\d{4}$/.test(year)) {
      throw new InvalidInvoiceStorageKeyError(String(issueDate));
    }
    return `${storeId}/${year}/${invoiceId}.pdf`;
  }

  /** Validates the key and resolves it to an absolute path inside root. */
  resolve(key: string): string {
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new InvalidInvoiceStorageKeyError(key);
    }
    const full = path.resolve(this.root, ...key.split('/'));
    const rel = path.relative(this.root, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new InvalidInvoiceStorageKeyError(key);
    }
    return full;
  }

  async exists(key: string): Promise<boolean> {
    try {
      const st = await fs.stat(this.resolve(key));
      return st.isFile() && st.size > 0;
    } catch (e) {
      if (e instanceof InvalidInvoiceStorageKeyError) throw e;
      return false;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    const file = this.resolve(key);
    try {
      return await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }
}
