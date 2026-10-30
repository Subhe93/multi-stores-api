import type { MailAttachment } from './order-mail.helpers';

/**
 * Seam for apps that send a store's email through an API instead of SMTP
 * (Zoho Mail app). Providers register with MailService on module init, so
 * the mail module never imports an app module (no cycle).
 */

export interface StoreMailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachment[];
}

export type StoreMailProviderResult =
  | { sent: true; host: string }
  | { sent: false; host: string; error: string };

export interface StoreMailProvider {
  /** Recorded as EmailLog.via (e.g. 'zoho'). */
  readonly via: string;
  /**
   * Send for the store, or null when the provider does not apply to it
   * (app off, not connected); null leaves the SMTP / platform path as is.
   */
  sendForStore(
    storeId: string,
    message: StoreMailMessage,
  ): Promise<StoreMailProviderResult | null>;
}
