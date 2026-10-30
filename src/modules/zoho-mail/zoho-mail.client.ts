/**
 * Zoho Mail / Zoho Accounts HTTP client. Pure helpers plus thin wrappers over
 * the global fetch. Secrets (client secret, codes, tokens) travel in a POST
 * form body or the Authorization header; the one exception is the revoke
 * call, which also carries the token as ?token= as Zoho documents it
 * (server-to-Zoho over TLS only). Secrets are never part of an error message.
 */

/** Zoho data centres (domain part of accounts.<dc> / mail.<dc>). */
export const ZOHO_REGIONS = [
  'zoho.com',
  'zoho.eu',
  'zoho.in',
  'zoho.com.cn',
  'zoho.com.au',
  'zoho.jp',
  'zohocloud.ca',
  'zoho.sa',
] as const;

export type ZohoRegion = (typeof ZOHO_REGIONS)[number];

/** Send + list accounts only. */
export const ZOHO_SCOPES =
  'VirtualOffice.messages.CREATE,VirtualOffice.accounts.READ';

/** Per-file attachment cap (same as Zoho's own plugin). */
export const ZOHO_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export function isZohoRegion(value: unknown): value is ZohoRegion {
  return (
    typeof value === 'string' &&
    (ZOHO_REGIONS as readonly string[]).includes(value)
  );
}

export function accountsHost(region: ZohoRegion): string {
  return `https://accounts.${region}`;
}

export function mailHost(region: ZohoRegion): string {
  return `https://mail.${region}`;
}

/**
 * Region of a callback `accounts-server` value, or null when it is not
 * exactly https://accounts.<allowed dc> (no port, path, query or userinfo).
 */
export function regionFromAccountsServer(
  value: string | undefined | null,
): ZohoRegion | null {
  if (!value || typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  const host = url.hostname.toLowerCase();
  if (!host.startsWith('accounts.')) return null;
  const dc = host.slice('accounts.'.length);
  return isZohoRegion(dc) ? dc : null;
}

export function buildAuthorizeUrl(input: {
  region: ZohoRegion;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    scope: ZOHO_SCOPES,
    redirect_uri: input.redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
  });
  return `${accountsHost(input.region)}/oauth/v2/auth?${params.toString()}`;
}

/** A failed Zoho call. `message` never contains secrets. */
export class ZohoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Zoho error code when the body carried one (invalid_code, ...). */
    readonly zohoCode?: string,
  ) {
    super(message);
    this.name = 'ZohoApiError';
  }
}

interface HttpResult {
  status: number;
  json: unknown;
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'error';
    throw new ZohoApiError(`Zoho request failed (${reason})`, 0);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Short, secret-free description of an error body. */
function describe(json: unknown): string | undefined {
  const body = obj(json);
  const data = obj(body.data);
  const status = obj(body.status);
  const text =
    str(body.error) ||
    str(data.errorCode) ||
    str(data.moreInfo) ||
    str(status.description);
  return text ? text.replace(/[\r\n]+/g, ' ').slice(0, 200) : undefined;
}

function fail(op: string, res: HttpResult): never {
  const code = describe(res.json);
  throw new ZohoApiError(
    `Zoho ${op} failed (HTTP ${res.status}${code ? `: ${code}` : ''})`,
    res.status,
    code,
  );
}

function formPost(url: string, fields: Record<string, string>) {
  return request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

export interface ZohoTokens {
  access_token: string;
  refresh_token?: string;
  /** Seconds. */
  expires_in: number;
}

function parseTokens(op: string, res: HttpResult): ZohoTokens {
  const body = obj(res.json);
  // Zoho answers token errors with HTTP 200 and an `error` field.
  if (res.status !== 200 || body.error || !str(body.access_token)) {
    fail(op, res);
  }
  const expires = Number(body.expires_in);
  return {
    access_token: body.access_token as string,
    refresh_token: str(body.refresh_token),
    expires_in: Number.isFinite(expires) && expires > 0 ? expires : 3600,
  };
}

export async function exchangeCode(input: {
  region: ZohoRegion;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<ZohoTokens> {
  const res = await formPost(`${accountsHost(input.region)}/oauth/v2/token`, {
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  });
  return parseTokens('token exchange', res);
}

export async function refreshAccessToken(input: {
  region: ZohoRegion;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<ZohoTokens> {
  const res = await formPost(`${accountsHost(input.region)}/oauth/v2/token`, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  return parseTokens('token refresh', res);
}

/** Revokes a refresh token. Throws on a non-2xx answer. */
export async function revokeToken(input: {
  region: ZohoRegion;
  token: string;
}): Promise<void> {
  const res = await formPost(
    // Zoho documents the token as a query parameter; it is also sent in the
    // body so either reading works.
    `${accountsHost(input.region)}/oauth/v2/token/revoke?token=${encodeURIComponent(input.token)}`,
    { token: input.token },
  );
  if (res.status < 200 || res.status >= 300) fail('token revoke', res);
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    Accept: 'application/json',
  };
}

export interface ZohoAccount {
  account_id: string;
  primary_email?: string;
  from_addresses: string[];
}

export interface ZohoFromAddress {
  address: string;
  account_id: string;
}

/** Normalizes the GET /api/accounts body. */
export function parseAccounts(json: unknown): ZohoAccount[] {
  const data = obj(json).data;
  if (!Array.isArray(data)) return [];
  const out: ZohoAccount[] = [];
  for (const raw of data) {
    const acc = obj(raw);
    const id =
      str(acc.accountId) ??
      (typeof acc.accountId === 'number' ? String(acc.accountId) : undefined);
    if (!id) continue;
    const details = Array.isArray(acc.sendMailDetails)
      ? acc.sendMailDetails
      : [];
    const from = details
      .map((d) => str(obj(d).fromAddress))
      .filter((a): a is string => !!a && isEmailAddress(a));
    out.push({
      account_id: id,
      primary_email:
        str(acc.primaryEmailAddress) ||
        str(acc.mailboxAddress) ||
        str(acc.incomingUserName),
      from_addresses: from,
    });
  }
  return out;
}

/** Every allowed sender mapped to the account that owns it (first wins). */
export function mapFromAddresses(accounts: ZohoAccount[]): ZohoFromAddress[] {
  const seen = new Set<string>();
  const out: ZohoFromAddress[] = [];
  for (const acc of accounts) {
    for (const address of acc.from_addresses) {
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address, account_id: acc.account_id });
    }
  }
  return out;
}

/** The account that may send as `address` (case-insensitive), or null. */
export function accountIdFor(
  list: ZohoFromAddress[],
  address: string,
): string | null {
  const key = address.trim().toLowerCase();
  return list.find((f) => f.address.toLowerCase() === key)?.account_id ?? null;
}

export async function fetchAccounts(input: {
  region: ZohoRegion;
  accessToken: string;
}): Promise<ZohoAccount[]> {
  const res = await request(`${mailHost(input.region)}/api/accounts`, {
    method: 'GET',
    headers: authHeaders(input.accessToken),
  });
  if (res.status !== 200) fail('accounts', res);
  return parseAccounts(res.json);
}

export interface ZohoUploadedAttachment {
  storeName: string;
  attachmentPath: string;
  attachmentName: string;
}

/** Filename safe for a query parameter and a mail client. */
export function safeFileName(name: string): string {
  const base = (name || 'attachment').split(/[\\/]/).pop() || 'attachment';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '_').trim();
  return (clean || 'attachment').slice(0, 200);
}

export async function uploadAttachment(input: {
  region: ZohoRegion;
  accessToken: string;
  accountId: string;
  filename: string;
  content: Buffer;
}): Promise<ZohoUploadedAttachment> {
  if (input.content.length > ZOHO_MAX_ATTACHMENT_BYTES) {
    throw new ZohoApiError('Zoho attachment exceeds 10 MB', 413);
  }
  const url =
    `${mailHost(input.region)}/api/accounts/${encodeURIComponent(input.accountId)}` +
    `/messages/attachments?fileName=${encodeURIComponent(safeFileName(input.filename))}`;
  const res = await request(
    url,
    {
      method: 'POST',
      headers: {
        ...authHeaders(input.accessToken),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(input.content),
    },
    UPLOAD_TIMEOUT_MS,
  );
  const data = obj(obj(res.json).data);
  const storeName = str(data.storeName);
  const attachmentPath = str(data.attachmentPath);
  const attachmentName = str(data.attachmentName);
  if (res.status !== 200 || !storeName || !attachmentPath || !attachmentName) {
    fail('attachment upload', res);
  }
  return { storeName, attachmentPath, attachmentName };
}

const EMAIL_RE =
  /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 320 && EMAIL_RE.test(value);
}

/** Comma-separated valid addresses (invalid entries are dropped). */
export function addressList(
  value: string | string[] | undefined,
): string | undefined {
  if (!value) return undefined;
  const parts = (Array.isArray(value) ? value : value.split(/[,;]/))
    .map((a) => a.trim())
    .filter((a) => a && isEmailAddress(a));
  return parts.length ? parts.join(',') : undefined;
}

/** One line, no control characters (header-injection safe). */
export function headerSafe(value: string, max = 998): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/** `Name <email>`, quoting the name when it holds address separators. */
export function formatFrom(address: string, name?: string | null): string {
  const clean = headerSafe(name ?? '', 100).replace(/["<>\\]/g, '');
  if (!clean) return address;
  return /[,;:@()[\]]/.test(clean)
    ? `"${clean}" <${address}>`
    : `${clean} <${address}>`;
}

export interface ZohoOutgoingMessage {
  fromAddress: string;
  fromName?: string | null;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface ZohoSendPayload {
  fromAddress: string;
  toAddress: string;
  ccAddress?: string;
  bccAddress?: string;
  replyTo?: string;
  subject: string;
  content: string;
  mailFormat: 'html' | 'plaintext';
  attachments?: ZohoUploadedAttachment[];
}

/** JSON body of POST /api/accounts/{id}/messages. */
export function buildSendPayload(
  msg: ZohoOutgoingMessage,
  attachments: ZohoUploadedAttachment[] = [],
): ZohoSendPayload {
  const toAddress = addressList(msg.to);
  if (!toAddress) throw new ZohoApiError('No valid recipient', 400);
  const payload: ZohoSendPayload = {
    fromAddress: formatFrom(msg.fromAddress, msg.fromName),
    toAddress,
    subject: headerSafe(msg.subject),
    content: msg.html ?? msg.text ?? '',
    mailFormat: msg.html ? 'html' : 'plaintext',
  };
  const cc = addressList(msg.cc);
  if (cc) payload.ccAddress = cc;
  const bcc = addressList(msg.bcc);
  if (bcc) payload.bccAddress = bcc;
  const replyTo = msg.replyTo?.trim();
  if (replyTo && isEmailAddress(replyTo)) payload.replyTo = replyTo;
  if (attachments.length) payload.attachments = attachments;
  return payload;
}

export async function sendMessage(input: {
  region: ZohoRegion;
  accessToken: string;
  accountId: string;
  payload: ZohoSendPayload;
}): Promise<void> {
  const res = await request(
    `${mailHost(input.region)}/api/accounts/${encodeURIComponent(input.accountId)}/messages`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(input.accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input.payload),
    },
  );
  if (res.status !== 200) fail('send', res);
}
