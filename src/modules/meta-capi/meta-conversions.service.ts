import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import {
  buildEventsRequestBody,
  buildPurchaseEvent,
  metaEventsUrl,
  splitFullName,
} from './meta-capi.payload';
import { readTrackingContext } from './tracking-context';

/** Per attempt; the caller is never waiting on this (fire-and-forget). */
export const META_CAPI_TIMEOUT_MS = 5000;

export type MetaPurchaseSkipReason =
  | 'order_not_found'
  | 'no_store'
  | 'not_configured'
  | 'test_order'
  | 'order_deleted'
  | 'no_consent_evidence'
  | 'token_unreadable'
  | 'request_failed';

export interface MetaPurchaseResult {
  sent: boolean;
  reason?: MetaPurchaseSkipReason;
}

interface AttemptOutcome {
  ok: boolean;
  /** Worth one more try: network error, timeout or HTTP 5xx. */
  retryable: boolean;
  /** Safe to log: status + Meta's error code/message, never the request. */
  detail: string;
}

/**
 * Server-side Meta Purchase event (Conversions API). Sent when an order
 * becomes confirmed for the customer, so the purchase is counted even when
 * the buyer never returns to the thank-you page. The browser pixel sends the
 * same event with `eventID = purchase_<order id>`; Meta deduplicates on it.
 *
 * Never throws and never logs the access token or personal data.
 */
@Injectable()
export class MetaConversionsService {
  private readonly logger = new Logger(MetaConversionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async sendPurchase(orderId: string): Promise<MetaPurchaseResult> {
    try {
      return await this.sendPurchaseOrThrow(orderId);
    } catch (err) {
      // Only the error class: a message could carry request details.
      this.logger.warn(
        `Meta Purchase for order ${orderId} failed unexpectedly (${
          err instanceof Error ? err.name : 'Error'
        })`,
      );
      return { sent: false, reason: 'request_failed' };
    }
  }

  private async sendPurchaseOrThrow(
    orderId: string,
  ): Promise<MetaPurchaseResult> {
    const head = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, store_id: true, is_test: true, deleted_at: true },
    });
    if (!head) return { sent: false, reason: 'order_not_found' };
    if (!head.store_id) return { sent: false, reason: 'no_store' };
    if (head.is_test) return { sent: false, reason: 'test_order' };
    if (head.deleted_at) return { sent: false, reason: 'order_deleted' };

    // The token column is omitted from every read by default; this is the
    // one place that asks for it.
    const store = await this.prisma.store.findUnique({
      where: { id: head.store_id },
      select: {
        meta_pixel_id: true,
        meta_capi_token: true,
        meta_test_event_code: true,
        consent_required: true,
        custom_domain: true,
      },
    });
    if (!store?.meta_pixel_id || !store.meta_capi_token) {
      return { sent: false, reason: 'not_configured' };
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        order_number: true,
        total: true,
        currency: true,
        paid_at: true,
        hostname: true,
        tracking_context: true,
        items: {
          select: {
            id: true,
            product_id: true,
            custom_product_id: true,
            quantity: true,
            unit_price: true,
          },
        },
        customer: {
          select: {
            first_name: true,
            last_name: true,
            phone: true,
            user: { select: { email: true } },
          },
        },
        address: {
          select: {
            full_name: true,
            city: true,
            postal_code: true,
            country_code: true,
            phone: true,
          },
        },
      },
    });
    if (!order) return { sent: false, reason: 'order_not_found' };

    // GDPR: a stored browser context is the evidence that the visitor
    // allowed marketing tracking (the storefront sends it only then). A store
    // that asks for consent and has none for this order sends nothing.
    const context = readTrackingContext(order.tracking_context);
    if (store.consent_required !== false && !context) {
      return { sent: false, reason: 'no_consent_evidence' };
    }

    const fromAddress = splitFullName(order.address?.full_name);
    const host = order.hostname || store.custom_domain;
    const event = buildPurchaseEvent({
      id: order.id,
      order_number: order.order_number,
      total: order.total,
      currency: order.currency,
      paid_at: order.paid_at,
      items: order.items.map((item) => ({
        id: item.product_id ?? item.custom_product_id ?? item.id,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
      customer: {
        email: order.customer?.user?.email,
        phone: order.customer?.phone || order.address?.phone,
        first_name: order.customer?.first_name || fromAddress.first,
        last_name: order.customer?.last_name || fromAddress.last,
        city: order.address?.city,
        postcode: order.address?.postal_code,
        country_code: order.address?.country_code,
      },
      context,
      fallback_source_url: host ? `https://${host}` : null,
    });

    // Decrypted here, right before the call, and never kept.
    let token: string | null;
    try {
      token = this.crypto.decrypt(store.meta_capi_token);
    } catch {
      token = null;
    }
    if (!token) {
      this.logger.warn(
        `Meta Purchase for order ${orderId} skipped: the stored access token cannot be decrypted`,
      );
      return { sent: false, reason: 'token_unreadable' };
    }

    const url = metaEventsUrl(store.meta_pixel_id);
    const body = JSON.stringify(
      buildEventsRequestBody(event, token, store.meta_test_event_code),
    );

    let outcome = await this.post(url, body, token);
    if (!outcome.ok && outcome.retryable) {
      outcome = await this.post(url, body, token);
    }
    if (!outcome.ok) {
      this.logger.warn(
        `Meta Purchase for order ${orderId} was not accepted: ${outcome.detail}`,
      );
      return { sent: false, reason: 'request_failed' };
    }
    this.logger.log(`Meta Purchase sent for order ${orderId}`);
    return { sent: true };
  }

  /** One POST. The token travels in the JSON body, never in the URL. */
  private async post(
    url: string,
    body: string,
    token: string,
  ): Promise<AttemptOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), META_CAPI_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, retryable: false, detail: 'ok' };
      return {
        ok: false,
        retryable: res.status >= 500,
        detail: `HTTP ${res.status}${await this.metaError(res, token)}`,
      };
    } catch (err) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        retryable: true,
        detail: aborted
          ? `timeout after ${META_CAPI_TIMEOUT_MS} ms`
          : `network error (${err instanceof Error ? err.name : 'Error'})`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Meta's `error` object as " code=… subcode=… message=…" (token scrubbed). */
  private async metaError(res: Response, token: string): Promise<string> {
    try {
      const parsed = (await res.json()) as {
        error?: {
          message?: unknown;
          code?: unknown;
          error_subcode?: unknown;
          fbtrace_id?: unknown;
        };
      };
      const e = parsed?.error;
      if (!e) return '';
      const parts: string[] = [];
      if (typeof e.code === 'number') parts.push(`code=${e.code}`);
      if (typeof e.error_subcode === 'number') {
        parts.push(`subcode=${e.error_subcode}`);
      }
      if (typeof e.message === 'string') {
        const message = e.message.split(token).join('[token]').slice(0, 300);
        parts.push(`message=${message}`);
      }
      if (typeof e.fbtrace_id === 'string') {
        parts.push(`fbtrace_id=${e.fbtrace_id.slice(0, 64)}`);
      }
      return parts.length ? ` ${parts.join(' ')}` : '';
    } catch {
      return '';
    }
  }
}
