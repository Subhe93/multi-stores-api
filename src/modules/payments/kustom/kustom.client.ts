import { createHash } from 'node:crypto';

/**
 * Derive a stable RFC 4122 v4-shaped UUID from an arbitrary key. Same input,
 * same UUID — that is what makes a retried Kustom write idempotent.
 */
export function toIdempotencyUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Minimal typed HTTP client for the Kustom Checkout + Order Management APIs.
 *
 * Kustom (former Klarna Checkout) has no SDK we can depend on, and the surface
 * we need is tiny, so this wraps the global fetch: Basic auth from the
 * creator's merchant id + shared secret, the optional platform partner header,
 * JSON handling, a hard timeout and a single error type carrying the HTTP
 * status + body so callers can branch on 401/404/409 without string matching.
 */

export type KustomEnvironment = 'playground' | 'production';

export interface KustomCredentials {
  merchantId: string;
  sharedSecret: string;
  environment: KustomEnvironment;
  /** Platform partner id, sent as `Kustom-Partner` when set. */
  partnerId?: string | null;
}

const BASE_URLS: Record<KustomEnvironment, string> = {
  playground: 'https://api.playground.kustom.co',
  production: 'https://api.kustom.co',
};

const REQUEST_TIMEOUT_MS = 10_000;

// ── Wire types (only the fields we read; Kustom returns more) ───────────────

export type KustomOrderLineType =
  | 'physical'
  | 'digital'
  | 'discount'
  | 'shipping_fee'
  | 'sales_tax'
  | 'gift_card'
  | 'store_credit'
  | 'surcharge';

export interface KustomOrderLine {
  type: KustomOrderLineType;
  reference?: string;
  name: string;
  quantity: number;
  quantity_unit?: string;
  /** Minor units. */
  unit_price: number;
  /** Basis points (2500 = 25 %). */
  tax_rate: number;
  /** Minor units. Must equal quantity * unit_price - total_discount_amount. */
  total_amount: number;
  /** Minor units, non-negative. */
  total_discount_amount: number;
  /** Minor units. */
  total_tax_amount: number;
  product_url?: string;
  image_url?: string;
}

export interface KustomAddress {
  given_name?: string;
  family_name?: string;
  email?: string;
  title?: string;
  street_address?: string;
  street_address2?: string;
  postal_code?: string;
  city?: string;
  region?: string;
  phone?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  organization_name?: string;
  care_of?: string;
}

export interface KustomMerchantUrls {
  terms: string;
  checkout: string;
  confirmation: string;
  push: string;
  validation?: string;
}

export interface KustomCheckoutOptions {
  auto_capture?: boolean;
  allow_separate_shipping_address?: boolean;
  phone_mandatory?: boolean;
  require_validate_callback_success?: boolean;
}

export interface KustomCheckoutPayload {
  purchase_country: string;
  purchase_currency: string;
  locale: string;
  order_amount: number;
  order_tax_amount: number;
  order_lines: KustomOrderLine[];
  merchant_reference1?: string;
  merchant_reference2?: string;
  merchant_urls: KustomMerchantUrls;
  billing_address?: KustomAddress;
  shipping_address?: KustomAddress;
  options?: KustomCheckoutOptions;
}

/** Checkout API order (`/checkout/v3/orders/{id}`). */
export interface KustomCheckoutOrder extends KustomCheckoutPayload {
  order_id: string;
  /** `checkout_incomplete` | `checkout_complete` (case varies across docs). */
  status: string;
  html_snippet?: string;
  started_at?: string;
  completed_at?: string;
  last_modified_at?: string;
}

/** Order Management API order (`/ordermanagement/v1/orders/{id}`). */
export interface KustomManagementOrder {
  order_id: string;
  /** AUTHORIZED | PART_CAPTURED | CAPTURED | CANCELLED | EXPIRED (case varies). */
  status: string;
  fraud_status?: string;
  order_amount: number;
  original_order_amount?: number;
  captured_amount?: number;
  refunded_amount?: number;
  remaining_authorized_amount?: number;
  purchase_currency: string;
  purchase_country?: string;
  locale?: string;
  merchant_reference1?: string;
  merchant_reference2?: string;
  klarna_reference?: string;
  billing_address?: KustomAddress;
  shipping_address?: KustomAddress;
  order_lines?: KustomOrderLine[];
  initial_payment_method?: { type?: string; description?: string };
  captures?: { capture_id?: string; captured_amount?: number }[];
  refunds?: { refund_id?: string; refunded_amount?: number }[];
  created_at?: string;
  expires_at?: string;
}

export interface KustomCaptureRequest {
  captured_amount: number;
  description?: string;
}

export interface KustomRefundRequest {
  refunded_amount: number;
  description?: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class KustomApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly action: string,
  ) {
    super(
      `Kustom ${action} failed with HTTP ${status}${
        body ? `: ${KustomApiError.describe(body)}` : ''
      }`,
    );
    this.name = 'KustomApiError';
  }

  /** Kustom error bodies carry `error_code` + `error_messages[]`. */
  private static describe(body: unknown): string {
    if (typeof body === 'string') return body.slice(0, 300);
    if (body && typeof body === 'object') {
      const b = body as { error_code?: string; error_messages?: string[] };
      const parts = [b.error_code, ...(b.error_messages ?? [])].filter(Boolean);
      if (parts.length) return parts.join(' — ').slice(0, 300);
      try {
        return JSON.stringify(body).slice(0, 300);
      } catch {
        return '';
      }
    }
    return '';
  }

  /** Error code as sent by Kustom, when the body was JSON. */
  get errorCode(): string | null {
    const b = this.body as { error_code?: string } | null;
    return b && typeof b === 'object' && typeof b.error_code === 'string'
      ? b.error_code
      : null;
  }
}

interface KustomResponse<T> {
  status: number;
  headers: Headers;
  body: T | null;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class KustomClient {
  constructor(private readonly creds: KustomCredentials) {}

  get baseUrl(): string {
    return BASE_URLS[this.creds.environment] ?? BASE_URLS.playground;
  }

  private authHeader(): string {
    const token = Buffer.from(
      `${this.creds.merchantId}:${this.creds.sharedSecret}`,
      'utf8',
    ).toString('base64');
    return `Basic ${token}`;
  }

  /**
   * Perform one request. Non-2xx responses become a KustomApiError carrying
   * the parsed body. The body is parsed only when Kustom says it is JSON and
   * actually sent one — several endpoints reply 201/204 with nothing.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    action: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<KustomResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.creds.partnerId) headers['Kustom-Partner'] = this.creds.partnerId;
    // Order Management writes (acknowledge/capture/refund/cancel) require an
    // idempotency key. Callers pass a deterministic key per logical operation
    // so a retry after a timeout replays it and Kustom deduplicates; Kustom
    // wants a UUID, so the key is hashed into the v4 format.
    if (opts.idempotencyKey) {
      headers['Klarna-Idempotency-Key'] = toIdempotencyUuid(
        opts.idempotencyKey,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KustomApiError(
        0,
        controller.signal.aborted ? 'request timed out' : message,
        action,
      );
    } finally {
      clearTimeout(timer);
    }

    const body = await KustomClient.readBody<T>(res);
    if (!res.ok) throw new KustomApiError(res.status, body, action);
    return { status: res.status, headers: res.headers, body };
  }

  private static async readBody<T>(res: Response): Promise<T | null> {
    const text = await res.text();
    if (!text) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
    return text as unknown as T;
  }

  /** Id from a `*-Id` header, else the last segment of `Location`, else null. */
  private static idFromHeaders(
    headers: Headers,
    idHeader: string,
  ): string | null {
    const direct = headers.get(idHeader);
    if (direct) return direct;
    const location = headers.get('location');
    if (!location) return null;
    const segment = location.split('?')[0].split('/').filter(Boolean).pop();
    return segment || null;
  }

  // ── Checkout API ─────────────────────────────────────────────────────────

  async createCheckout(
    payload: KustomCheckoutPayload,
  ): Promise<KustomCheckoutOrder> {
    const { body } = await this.request<KustomCheckoutOrder>(
      'POST',
      '/checkout/v3/orders',
      'create checkout',
      { body: payload },
    );
    if (!body || typeof body !== 'object') {
      throw new KustomApiError(0, 'empty response', 'create checkout');
    }
    return body;
  }

  async getCheckout(kustomOrderId: string): Promise<KustomCheckoutOrder> {
    const { body } = await this.request<KustomCheckoutOrder>(
      'GET',
      `/checkout/v3/orders/${encodeURIComponent(kustomOrderId)}`,
      'read checkout',
    );
    if (!body || typeof body !== 'object') {
      throw new KustomApiError(0, 'empty response', 'read checkout');
    }
    return body;
  }

  async updateCheckout(
    kustomOrderId: string,
    payload: KustomCheckoutPayload,
  ): Promise<KustomCheckoutOrder> {
    const { body } = await this.request<KustomCheckoutOrder>(
      'POST',
      `/checkout/v3/orders/${encodeURIComponent(kustomOrderId)}`,
      'update checkout',
      { body: payload },
    );
    if (!body || typeof body !== 'object') {
      throw new KustomApiError(0, 'empty response', 'update checkout');
    }
    return body;
  }

  // ── Order Management API ─────────────────────────────────────────────────

  async getOrder(kustomOrderId: string): Promise<KustomManagementOrder> {
    const { body } = await this.request<KustomManagementOrder>(
      'GET',
      `/ordermanagement/v1/orders/${encodeURIComponent(kustomOrderId)}`,
      'read order',
    );
    if (!body || typeof body !== 'object') {
      throw new KustomApiError(0, 'empty response', 'read order');
    }
    return body;
  }

  /** Stops Kustom's push retries. 204, no body. */
  async acknowledge(kustomOrderId: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/ordermanagement/v1/orders/${encodeURIComponent(kustomOrderId)}/acknowledge`,
      'acknowledge order',
      { idempotencyKey: `${kustomOrderId}:acknowledge` },
    );
  }

  /** Capture (part of) the authorization. Returns the capture id when Kustom exposes one. */
  async capture(
    kustomOrderId: string,
    req: KustomCaptureRequest,
    idempotencyKey: string,
  ): Promise<string | null> {
    const { headers } = await this.request<void>(
      'POST',
      `/ordermanagement/v1/orders/${encodeURIComponent(kustomOrderId)}/captures`,
      'capture order',
      { body: req, idempotencyKey },
    );
    return KustomClient.idFromHeaders(headers, 'capture-id');
  }

  /** Refund captured money. Returns the refund id when Kustom exposes one. */
  async refund(
    kustomOrderId: string,
    req: KustomRefundRequest,
    idempotencyKey: string,
  ): Promise<string | null> {
    const { headers, body } = await this.request<unknown>(
      'POST',
      `/ordermanagement/v1/orders/${encodeURIComponent(kustomOrderId)}/refunds`,
      'refund order',
      { body: req, idempotencyKey },
    );
    const fromHeaders = KustomClient.idFromHeaders(headers, 'refund-id');
    if (fromHeaders) return fromHeaders;
    // Some deployments answer with the bare refund id as the body.
    return typeof body === 'string' && body.trim() ? body.trim() : null;
  }

  /** Release the authorization. Only allowed while nothing is captured. 204. */
  async cancel(kustomOrderId: string, idempotencyKey: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/ordermanagement/v1/orders/${encodeURIComponent(kustomOrderId)}/cancel`,
      'cancel order',
      { idempotencyKey },
    );
  }
}
