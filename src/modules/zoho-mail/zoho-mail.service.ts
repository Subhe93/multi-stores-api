import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, StoreType, type StoreZohoMail } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MailService } from '../mail/mail.service';
import type {
  StoreMailMessage,
  StoreMailProvider,
  StoreMailProviderResult,
} from '../mail/store-mail-provider';
import {
  ZOHO_MAX_ATTACHMENT_BYTES,
  ZohoApiError,
  accountIdFor,
  buildAuthorizeUrl,
  buildSendPayload,
  exchangeCode,
  fetchAccounts,
  isZohoRegion,
  mapFromAddresses,
  refreshAccessToken,
  regionFromAccountsServer,
  revokeToken,
  sendMessage,
  uploadAttachment,
  type ZohoAccount,
  type ZohoFromAddress,
  type ZohoOutgoingMessage,
  type ZohoRegion,
  type ZohoTokens,
  type ZohoUploadedAttachment,
} from './zoho-mail.client';
import { ZOHO_STATE_TTL_MS, signState, verifyState } from './zoho-mail.state';

export const ZOHO_APP_KEY = 'zoho_mail' as const;

/** Error codes of the creator routes (body.code). */
export const ZOHO_ERRORS = {
  REQUIRES_INDEPENDENT: 'ZOHO_MAIL_REQUIRES_INDEPENDENT',
  CLIENT_NOT_CONFIGURED: 'ZOHO_CLIENT_NOT_CONFIGURED',
  INVALID_REGION: 'ZOHO_MAIL_INVALID_REGION',
  INVALID_CLIENT: 'ZOHO_MAIL_INVALID_CLIENT',
  NOT_CONNECTED: 'ZOHO_MAIL_NOT_CONNECTED',
  FROM_NOT_ALLOWED: 'ZOHO_MAIL_FROM_NOT_ALLOWED',
  RECONNECT_REQUIRED: 'ZOHO_MAIL_RECONNECT_REQUIRED',
  API_ERROR: 'ZOHO_MAIL_API_ERROR',
} as const;

/** Codes stored in StoreZohoMail.last_error (the detail goes alongside). */
export const ZOHO_LAST_ERRORS = {
  RECONNECT_REQUIRED: 'ZOHO_MAIL_RECONNECT_REQUIRED',
  SEND_FAILED: 'ZOHO_MAIL_SEND_FAILED',
  API_ERROR: 'ZOHO_MAIL_API_ERROR',
  ATTACHMENT_TOO_LARGE: 'ZOHO_MAIL_ATTACHMENT_TOO_LARGE',
  NO_FROM_ADDRESS: 'ZOHO_MAIL_NO_FROM_ADDRESS',
} as const;

/** `?error=` values of the OAuth callback redirect. */
export type ZohoCallbackError =
  | 'access_denied'
  | 'zoho_error'
  | 'missing_code'
  | 'invalid_state'
  | 'state_expired'
  | 'state_used'
  | 'invalid_server'
  | 'client_not_configured'
  | 'not_allowed'
  | 'token_failed'
  | 'no_refresh_token'
  | 'accounts_failed'
  | 'no_from_address';

export interface ZohoMailStatus {
  /** client_id + client_secret saved. */
  client_configured: boolean;
  client_id: string | null;
  has_client_secret: boolean;
  /** The Authorized Redirect URI to register in the Zoho API console. */
  redirect_uri: string;
  enabled: boolean;
  connected: boolean;
  region: string | null;
  connected_email: string | null;
  from_address: string | null;
  from_name: string | null;
  available_from: string[];
  connected_at: Date | null;
  verified_at: Date | null;
  /** Stable code (ZOHO_MAIL_*), see ZOHO_LAST_ERRORS. */
  last_error: string | null;
  /** Secret-free technical detail of the last error. */
  last_error_detail: string | null;
  last_error_at: Date | null;
}

export interface ZohoCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  'accounts-server'?: string;
  location?: string;
}

/** Refresh the access token this long before Zoho expires it. */
const TOKEN_SKEW_MS = 60_000;
const NONCE_MAX = 5000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

/** Token / mailbox columns reset when the connection is dropped. */
const DISCONNECTED = {
  refresh_token: null,
  access_token: null,
  access_expires_at: null,
  connected_at: null,
  connected_email: null,
  account_id: null,
  from_address: null,
  available_from: [] as unknown as Prisma.InputJsonValue,
  verified_at: null,
  last_error: null,
  last_error_detail: null,
  last_error_at: null,
};

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** Refresh token / client rejected by Zoho: the creator must connect again. */
function isGrantError(err: unknown): boolean {
  return (
    err instanceof ZohoApiError &&
    /invalid_code|invalid_grant|invalid_client|access_denied/i.test(
      err.zohoCode ?? err.message,
    )
  );
}

export function parseAvailableFrom(value: Prisma.JsonValue): ZohoFromAddress[] {
  if (!Array.isArray(value)) return [];
  const out: ZohoFromAddress[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { address, account_id } = item as Record<string, unknown>;
    if (typeof address === 'string' && typeof account_id === 'string') {
      out.push({ address, account_id });
    }
  }
  return out;
}

/**
 * Zoho Mail app: each store registers ITS OWN Zoho OAuth client (client id +
 * encrypted secret, like Zoho's WordPress plugin), authorizes its mailbox,
 * and this StoreMailProvider then sends the store's transactional email
 * through the Zoho Mail API. Tokens are encrypted at rest; access tokens are
 * cached in memory and in the row, and refreshed once on a 401.
 */
@Injectable()
export class ZohoMailService implements OnModuleInit, StoreMailProvider {
  readonly via = 'zoho';
  private readonly logger = new Logger(ZohoMailService.name);
  private readonly tokens = new Map<string, CachedToken>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly usedNonces = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly storeApps: StoreAppsService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    this.mail.registerStoreMailProvider(this);
  }

  // ── Config ────────────────────────────────────────────────────────────────

  /** Same for every store: ZOHO_REDIRECT_URI, else PUBLIC_API_URL + path. */
  redirectUri(): string {
    const override = this.config.get<string>('ZOHO_REDIRECT_URI')?.trim();
    if (override) return override;
    const base = (
      this.config.get<string>('PUBLIC_API_URL') || 'http://localhost:3001'
    ).replace(/\/+$/, '');
    return `${base}/api/zoho-mail/oauth/callback`;
  }

  private stateSecret(): string {
    const secret =
      this.config.get<string>('JWT_SECRET') ||
      this.config.get<string>('ENCRYPTION_KEY');
    if (!secret) throw new Error('No server secret to sign the OAuth state');
    return secret;
  }

  private dashboardPage(): string {
    const base = (
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:3002'
    ).replace(/\/+$/, '');
    return `${base}/creator/zoho-mail`;
  }

  /** The row's client credentials, or null when incomplete. */
  private credsOf(row: StoreZohoMail | null): ClientCreds | null {
    if (!row?.client_id || !row.client_secret) return null;
    const clientSecret = this.crypto.decrypt(row.client_secret);
    if (!clientSecret) return null;
    return { clientId: row.client_id, clientSecret };
  }

  private requireCreds(row: StoreZohoMail | null): ClientCreds {
    const creds = this.credsOf(row);
    if (!creds) {
      throw new ConflictException({
        code: ZOHO_ERRORS.CLIENT_NOT_CONFIGURED,
        message: 'Save your Zoho client id and client secret first.',
      });
    }
    return creds;
  }

  // ── Store resolution ──────────────────────────────────────────────────────

  /** The caller's INDEPENDENT store (404 / 403 otherwise). */
  private async requireStore(userId: string) {
    const store = await this.storeApps.storeOfCreator(userId);
    if (store.store_type !== StoreType.INDEPENDENT) {
      throw new ForbiddenException({
        code: ZOHO_ERRORS.REQUIRES_INDEPENDENT,
        message: 'Only independent stores can send through Zoho Mail.',
      });
    }
    return store;
  }

  private findRow(storeId: string): Promise<StoreZohoMail | null> {
    return this.prisma.storeZohoMail.findUnique({
      where: { store_id: storeId },
    });
  }

  /** A row with a live connection (refresh token), else 404. */
  private async requireConnected(storeId: string): Promise<StoreZohoMail> {
    const row = await this.findRow(storeId);
    if (!row?.refresh_token) {
      throw new NotFoundException({
        code: ZOHO_ERRORS.NOT_CONNECTED,
        message: 'Connect a Zoho Mail account first.',
      });
    }
    return row;
  }

  private view(row: StoreZohoMail | null, enabled: boolean): ZohoMailStatus {
    const live = row?.refresh_token ? row : null;
    return {
      client_configured: !!row?.client_id && !!row?.client_secret,
      client_id: row?.client_id ?? null,
      has_client_secret: !!row?.client_secret,
      redirect_uri: this.redirectUri(),
      enabled,
      connected: !!live,
      region: row?.region ?? null,
      connected_email: live?.connected_email ?? null,
      from_address: live?.from_address ?? null,
      from_name: row?.from_name ?? null,
      available_from: live
        ? parseAvailableFrom(live.available_from).map((f) => f.address)
        : [],
      connected_at: live?.connected_at ?? null,
      verified_at: live?.verified_at ?? null,
      last_error: row?.last_error ?? null,
      last_error_detail: row?.last_error_detail ?? null,
      last_error_at: row?.last_error_at ?? null,
    };
  }

  private async statusOf(storeId: string): Promise<ZohoMailStatus> {
    const [row, enabled] = await Promise.all([
      this.findRow(storeId),
      this.storeApps.isEnabled(storeId, ZOHO_APP_KEY),
    ]);
    return this.view(row, enabled);
  }

  // ── Creator routes ────────────────────────────────────────────────────────

  async status(userId: string): Promise<ZohoMailStatus> {
    const store = await this.requireStore(userId);
    return this.statusOf(store.id);
  }

  /**
   * Save the store's Zoho client. An omitted secret keeps the stored one;
   * changing the client id or the region drops the current connection.
   */
  async saveClient(
    userId: string,
    input: { region: unknown; client_id: string; client_secret?: string },
  ): Promise<ZohoMailStatus> {
    const store = await this.requireStore(userId);
    if (!isZohoRegion(input.region)) {
      throw new BadRequestException({
        code: ZOHO_ERRORS.INVALID_REGION,
        message: 'Unknown Zoho data centre.',
      });
    }
    const region = input.region;
    const clientId = (input.client_id ?? '').trim();
    const secret = input.client_secret?.trim();
    if (!clientId || /\s/.test(clientId) || (secret && /\s/.test(secret))) {
      throw new BadRequestException({
        code: ZOHO_ERRORS.INVALID_CLIENT,
        message: 'Enter the Client ID and Client Secret from the Zoho console.',
      });
    }
    const row = await this.findRow(store.id);
    const clientChanged =
      !!row && (row.client_id !== clientId || row.region !== region);

    if (row && clientChanged && row.refresh_token) {
      // The old token belongs to the old client: revoke it with the old creds.
      await this.revokeQuietly(row);
    }
    const data = {
      region,
      client_id: clientId,
      ...(secret ? { client_secret: this.crypto.encrypt(secret) } : {}),
      ...(clientChanged ? DISCONNECTED : {}),
    };
    if (row) {
      await this.prisma.storeZohoMail.update({
        where: { store_id: store.id },
        data,
      });
    } else {
      await this.prisma.storeZohoMail.create({
        data: { store_id: store.id, ...data },
      });
    }
    if (clientChanged) this.forget(store.id);
    return this.statusOf(store.id);
  }

  async connect(userId: string): Promise<{ authorize_url: string }> {
    const store = await this.requireStore(userId);
    const row = await this.findRow(store.id);
    const creds = this.requireCreds(row);
    const region = row?.region;
    if (!isZohoRegion(region)) {
      throw new BadRequestException({
        code: ZOHO_ERRORS.INVALID_REGION,
        message: 'Unknown Zoho data centre.',
      });
    }
    const { state } = signState(this.stateSecret(), {
      storeId: store.id,
      userId,
      region,
    });
    return {
      authorize_url: buildAuthorizeUrl({
        region,
        clientId: creds.clientId,
        redirectUri: this.redirectUri(),
        state,
      }),
    };
  }

  async updateSender(
    userId: string,
    input: { from_address: string; from_name?: string | null },
  ): Promise<ZohoMailStatus> {
    const store = await this.requireStore(userId);
    const row = await this.requireConnected(store.id);
    const list = parseAvailableFrom(row.available_from);
    const address = (input.from_address ?? '').trim();
    const accountId = address ? accountIdFor(list, address) : null;
    if (!accountId) {
      throw new BadRequestException({
        code: ZOHO_ERRORS.FROM_NOT_ALLOWED,
        message: 'This address is not an allowed sender of the Zoho account.',
      });
    }
    const canonical =
      list.find((f) => f.address.toLowerCase() === address.toLowerCase())
        ?.address ?? address;
    const name =
      input.from_name === undefined
        ? row.from_name
        : (input.from_name ?? '').replace(/[\r\n]+/g, ' ').trim() || null;
    await this.prisma.storeZohoMail.update({
      where: { store_id: store.id },
      data: { from_address: canonical, account_id: accountId, from_name: name },
    });
    return this.statusOf(store.id);
  }

  async refreshAddresses(userId: string): Promise<ZohoMailStatus> {
    const store = await this.requireStore(userId);
    const row = await this.requireConnected(store.id);
    this.requireCreds(row);
    try {
      const region = this.regionOf(row);
      const accounts = await this.withToken(row, (token) =>
        fetchAccounts({ region, accessToken: token }),
      );
      const list = mapFromAddresses(accounts);
      const from = this.pickFrom(
        list,
        row.from_address,
        accounts[0]?.primary_email,
      );
      await this.prisma.storeZohoMail.update({
        where: { store_id: store.id },
        data: {
          available_from: list as unknown as Prisma.InputJsonValue,
          from_address: from?.address ?? null,
          account_id: from?.account_id ?? null,
          connected_email: accounts[0]?.primary_email ?? row.connected_email,
        },
      });
    } catch (err) {
      await this.recordError(store.id, err, ZOHO_LAST_ERRORS.API_ERROR);
      throw this.apiException(err);
    }
    return this.statusOf(store.id);
  }

  async sendTest(
    userId: string,
    to: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const store = await this.requireStore(userId);
    const row = await this.requireConnected(store.id);
    this.requireCreds(row);
    if (!row.from_address || !row.account_id) {
      return { ok: false, error: ZOHO_LAST_ERRORS.NO_FROM_ADDRESS };
    }
    try {
      await this.deliver(row, {
        to,
        subject: 'Test email from your store (Zoho Mail)',
        html: '<p>Your store is sending email through Zoho Mail. ✅</p>',
        text: 'Your store is sending email through Zoho Mail.',
      });
      await this.prisma.storeZohoMail.update({
        where: { store_id: store.id },
        data: {
          verified_at: new Date(),
          last_error: null,
          last_error_detail: null,
          last_error_at: null,
        },
      });
      return { ok: true };
    } catch (err) {
      const code = await this.recordError(
        store.id,
        err,
        ZOHO_LAST_ERRORS.SEND_FAILED,
      );
      return { ok: false, error: code };
    }
  }

  /** Revoke (best effort) and drop the token; the client too unless kept. */
  async disconnect(
    userId: string,
    keepClient = false,
  ): Promise<ZohoMailStatus> {
    const store = await this.requireStore(userId);
    const row = await this.findRow(store.id);
    if (row) {
      if (row.refresh_token) await this.revokeQuietly(row);
      if (keepClient) {
        await this.prisma.storeZohoMail.update({
          where: { store_id: store.id },
          data: DISCONNECTED,
        });
      } else {
        await this.prisma.storeZohoMail.deleteMany({
          where: { store_id: store.id },
        });
      }
    }
    this.forget(store.id);
    return this.statusOf(store.id);
  }

  // ── OAuth callback ────────────────────────────────────────────────────────

  /**
   * Handles the Zoho redirect; always returns the dashboard URL to 302 to,
   * never throws (a public endpoint must not answer 500 / JSON).
   */
  async handleCallback(query: ZohoCallbackQuery): Promise<string> {
    const issued: { region?: ZohoRegion; token?: string } = {};
    try {
      return await this.runCallback(query, issued);
    } catch (err) {
      this.logger.warn(`Zoho OAuth callback failed: ${errorText(err)}`);
      // A token Zoho already issued must not outlive the failed flow.
      if (issued.region && issued.token) {
        await this.revokePlain(issued.region, issued.token);
      }
      return `${this.dashboardPage()}?error=token_failed`;
    }
  }

  private async runCallback(
    query: ZohoCallbackQuery,
    issued: { region?: ZohoRegion; token?: string },
  ): Promise<string> {
    const page = this.dashboardPage();
    const failWith = (code: ZohoCallbackError) =>
      `${page}?error=${encodeURIComponent(code)}`;

    if (query.error) {
      return failWith(
        query.error === 'access_denied' ? 'access_denied' : 'zoho_error',
      );
    }

    const verified = verifyState(this.stateSecret(), query.state);
    if (!verified.ok) return failWith(verified.error);
    const state = verified.payload;
    if (!this.consumeNonce(state.nonce, state.exp)) {
      return failWith('state_used');
    }
    if (!query.code || typeof query.code !== 'string') {
      return failWith('missing_code');
    }

    // Multi-DC: the account may live in another data centre than chosen.
    let region: ZohoRegion = state.region;
    if (query['accounts-server']) {
      const dc = regionFromAccountsServer(query['accounts-server']);
      if (!dc) return failWith('invalid_server');
      region = dc;
    }

    // The user must still own the store, which must still qualify.
    if (!(await this.callbackAllowed(state.userId, state.storeId))) {
      return failWith('not_allowed');
    }
    const previous = await this.findRow(state.storeId);
    const creds = this.credsOf(previous);
    if (!previous || !creds) return failWith('client_not_configured');
    // The client was switched to another region since the state was made.
    if (previous.region !== state.region) return failWith('invalid_state');

    let tokens: ZohoTokens;
    try {
      tokens = await exchangeCode({
        region,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        redirectUri: this.redirectUri(),
        code: query.code,
      });
    } catch (err) {
      this.logger.warn(
        `Zoho token exchange failed for store ${state.storeId}: ${errorText(err)}`,
      );
      return failWith('token_failed');
    }
    issued.region = region;
    issued.token = tokens.refresh_token ?? tokens.access_token;
    if (!tokens.refresh_token) {
      await this.revokePlain(region, tokens.access_token);
      return failWith('no_refresh_token');
    }

    let accounts: ZohoAccount[];
    try {
      accounts = await fetchAccounts({
        region,
        accessToken: tokens.access_token,
      });
    } catch (err) {
      this.logger.warn(
        `Zoho accounts fetch failed for store ${state.storeId}: ${errorText(err)}`,
      );
      await this.revokePlain(region, tokens.refresh_token);
      return failWith('accounts_failed');
    }
    const list = mapFromAddresses(accounts);
    if (!list.length) {
      await this.revokePlain(region, tokens.refresh_token);
      return failWith('no_from_address');
    }

    const store = await this.prisma.store.findUnique({
      where: { id: state.storeId },
      select: { name: true },
    });
    const connectedEmail = accounts[0]?.primary_email ?? list[0].address;
    const from = this.pickFrom(
      list,
      previous.refresh_token ? previous.from_address : null,
      connectedEmail,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);
    // A replaced connection's token is revoked first (best effort).
    if (previous.refresh_token) await this.revokeQuietly(previous);
    // A concurrent callback may have stored another token meanwhile.
    const latest = await this.findRow(state.storeId);
    if (
      latest?.refresh_token &&
      latest.refresh_token !== previous.refresh_token
    ) {
      await this.revokeQuietly(latest);
    }
    await this.prisma.storeZohoMail.update({
      where: { store_id: state.storeId },
      data: {
        region,
        connected_email: connectedEmail,
        account_id: from?.account_id ?? null,
        from_address: from?.address ?? null,
        from_name: previous.from_name ?? store?.name ?? null,
        available_from: list as unknown as Prisma.InputJsonValue,
        refresh_token: this.crypto.encrypt(tokens.refresh_token),
        access_token: this.crypto.encrypt(tokens.access_token),
        access_expires_at: expiresAt,
        connected_at: now,
        verified_at: null,
        last_error: null,
        last_error_detail: null,
        last_error_at: null,
      },
    });
    // Stored: from here on the token must not be revoked by the catch.
    issued.token = undefined;
    this.tokens.set(state.storeId, {
      token: tokens.access_token,
      expiresAt: expiresAt.getTime(),
    });
    return `${page}?connected=1`;
  }

  private async callbackAllowed(
    userId: string,
    storeId: string,
  ): Promise<boolean> {
    const owned = await this.storeApps.storeIdByUser(userId);
    if (owned !== storeId) return false;
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { store_type: true },
    });
    if (store?.store_type !== StoreType.INDEPENDENT) return false;
    return this.storeApps.isEnabled(storeId, ZOHO_APP_KEY);
  }

  /** Single use per process; entries expire with the state. */
  private consumeNonce(nonce: string, exp: number): boolean {
    const now = Date.now();
    for (const [n, e] of this.usedNonces) {
      if (e <= now) this.usedNonces.delete(n);
    }
    if (this.usedNonces.has(nonce)) return false;
    if (this.usedNonces.size >= NONCE_MAX) {
      const oldest = this.usedNonces.keys().next();
      if (!oldest.done) this.usedNonces.delete(oldest.value);
    }
    this.usedNonces.set(nonce, Math.min(exp, now + ZOHO_STATE_TTL_MS));
    return true;
  }

  // ── Sending (StoreMailProvider) ───────────────────────────────────────────

  async sendForStore(
    storeId: string,
    message: StoreMailMessage,
  ): Promise<StoreMailProviderResult | null> {
    if (!(await this.storeApps.isEnabled(storeId, ZOHO_APP_KEY))) return null;
    const row = await this.prisma.storeZohoMail.findUnique({
      where: { store_id: storeId },
      include: { store: { select: { store_type: true } } },
    });
    if (!row?.refresh_token || !row.from_address || !row.account_id) {
      return null;
    }
    if (!row.client_id || !row.client_secret) return null;
    if (row.store.store_type !== StoreType.INDEPENDENT) return null;

    const host = `mail.${row.region}`;
    try {
      await this.deliver(row, message);
      if (row.last_error) {
        await this.prisma.storeZohoMail
          .update({
            where: { store_id: storeId },
            data: {
              last_error: null,
              last_error_detail: null,
              last_error_at: null,
            },
          })
          .catch(() => undefined);
      }
      return { sent: true, host };
    } catch (err) {
      const code = await this.recordError(
        storeId,
        err,
        ZOHO_LAST_ERRORS.SEND_FAILED,
      );
      return { sent: false, host, error: `${code}: ${errorText(err)}` };
    }
  }

  /** Uploads attachments, then sends; the whole call retries once on 401. */
  private async deliver(
    row: StoreZohoMail,
    message: StoreMailMessage,
  ): Promise<void> {
    const region = this.regionOf(row);
    const accountId = row.account_id as string;
    const files = message.attachments ?? [];
    for (const f of files) {
      if (f.content.length > ZOHO_MAX_ATTACHMENT_BYTES) {
        throw new ZohoApiError(
          `Attachment "${f.filename}" exceeds the 10 MB Zoho limit`,
          413,
        );
      }
    }
    const outgoing: ZohoOutgoingMessage = {
      fromAddress: row.from_address as string,
      fromName: row.from_name,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    // Validates recipients before any upload.
    buildSendPayload(outgoing);
    await this.withToken(row, async (token) => {
      const uploaded: ZohoUploadedAttachment[] = [];
      for (const f of files) {
        uploaded.push(
          await uploadAttachment({
            region,
            accessToken: token,
            accountId,
            filename: f.filename,
            content: f.content,
          }),
        );
      }
      await sendMessage({
        region,
        accessToken: token,
        accountId,
        payload: buildSendPayload(outgoing, uploaded),
      });
    });
  }

  // ── Tokens ────────────────────────────────────────────────────────────────

  private regionOf(row: StoreZohoMail): ZohoRegion {
    if (!isZohoRegion(row.region)) {
      throw new ZohoApiError('Stored Zoho region is invalid', 0);
    }
    return row.region;
  }

  /** Runs `fn` with a valid access token; on a 401 refreshes once and retries. */
  private async withToken<T>(
    row: StoreZohoMail,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.accessToken(row, false);
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof ZohoApiError) || err.status !== 401) throw err;
      this.tokens.delete(row.store_id);
      const fresh = await this.accessToken(row, true);
      return fn(fresh);
    }
  }

  private async accessToken(
    row: StoreZohoMail,
    force: boolean,
  ): Promise<string> {
    const now = Date.now();
    if (!force) {
      const mem = this.tokens.get(row.store_id);
      if (mem && mem.expiresAt - TOKEN_SKEW_MS > now) return mem.token;
      const exp = row.access_expires_at?.getTime() ?? 0;
      if (row.access_token && exp - TOKEN_SKEW_MS > now) {
        const token = this.crypto.decrypt(row.access_token);
        if (token) {
          this.tokens.set(row.store_id, { token, expiresAt: exp });
          return token;
        }
      }
    }
    // One refresh at a time per store.
    const inflight = this.refreshing.get(row.store_id);
    if (inflight) return inflight;
    const job = this.refresh(row).finally(() =>
      this.refreshing.delete(row.store_id),
    );
    this.refreshing.set(row.store_id, job);
    return job;
  }

  private async refresh(row: StoreZohoMail): Promise<string> {
    const creds = this.credsOf(row);
    if (!creds) throw new ZohoApiError('Zoho client is not configured', 0);
    const refreshToken = this.crypto.decrypt(row.refresh_token);
    if (!refreshToken) throw new ZohoApiError('No Zoho refresh token', 401);
    let tokens: ZohoTokens;
    try {
      tokens = await refreshAccessToken({
        region: this.regionOf(row),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken,
      });
    } catch (err) {
      if (isGrantError(err)) await this.markReconnectRequired(row.store_id);
      throw err;
    }
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    this.tokens.set(row.store_id, {
      token: tokens.access_token,
      expiresAt: expiresAt.getTime(),
    });
    await this.prisma.storeZohoMail
      .update({
        where: { store_id: row.store_id },
        data: {
          access_token: this.crypto.encrypt(tokens.access_token),
          access_expires_at: expiresAt,
        },
      })
      .catch(() => undefined);
    return tokens.access_token;
  }

  /**
   * The grant is gone (revoked / client changed at Zoho): drop the tokens so
   * status reports connected=false and sends skip Zoho without a refresh
   * attempt per email.
   */
  private async markReconnectRequired(storeId: string): Promise<void> {
    this.forget(storeId);
    await this.prisma.storeZohoMail
      .updateMany({
        where: { store_id: storeId },
        data: {
          refresh_token: null,
          access_token: null,
          access_expires_at: null,
          last_error: ZOHO_LAST_ERRORS.RECONNECT_REQUIRED,
          last_error_detail: 'Zoho rejected the stored authorization.',
          last_error_at: new Date(),
        },
      })
      .catch(() => undefined);
  }

  private forget(storeId: string): void {
    this.tokens.delete(storeId);
    this.refreshing.delete(storeId);
  }

  /** Revokes the row's stored refresh token (best effort). */
  private async revokeQuietly(row: StoreZohoMail): Promise<void> {
    const token = row.refresh_token
      ? this.crypto.decrypt(row.refresh_token)
      : null;
    if (!token || !isZohoRegion(row.region)) return;
    await this.revokePlain(row.region, token);
  }

  private async revokePlain(region: ZohoRegion, token: string): Promise<void> {
    try {
      await revokeToken({ region, token });
    } catch (err) {
      this.logger.warn(`Zoho token revoke failed: ${errorText(err)}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Keep the current sender when still allowed, else the mailbox, else first. */
  private pickFrom(
    list: ZohoFromAddress[],
    current: string | null,
    preferred: string | undefined,
  ): ZohoFromAddress | null {
    const find = (a?: string | null) =>
      a
        ? list.find((f) => f.address.toLowerCase() === a.toLowerCase())
        : undefined;
    return find(current) ?? find(preferred) ?? list[0] ?? null;
  }

  /** Stores a stable code + secret-free detail; returns the code. */
  private async recordError(
    storeId: string,
    err: unknown,
    fallback: string,
  ): Promise<string> {
    const code = isGrantError(err)
      ? ZOHO_LAST_ERRORS.RECONNECT_REQUIRED
      : err instanceof ZohoApiError && err.status === 413
        ? ZOHO_LAST_ERRORS.ATTACHMENT_TOO_LARGE
        : fallback;
    const detail = errorText(err);
    this.logger.warn(`Zoho Mail error for store ${storeId}: ${code} ${detail}`);
    await this.prisma.storeZohoMail
      .updateMany({
        where: { store_id: storeId },
        data: {
          last_error: code,
          last_error_detail: detail,
          last_error_at: new Date(),
        },
      })
      .catch(() => undefined);
    return code;
  }

  private apiException(err: unknown) {
    if (isGrantError(err)) {
      return new ConflictException({
        code: ZOHO_ERRORS.RECONNECT_REQUIRED,
        message: 'Zoho rejected the stored authorization; connect again.',
      });
    }
    return new BadGatewayException({
      code: ZOHO_ERRORS.API_ERROR,
      message: errorText(err),
    });
  }
}
