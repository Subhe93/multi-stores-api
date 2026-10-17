import { Logger } from '@nestjs/common';
// `pg` ships no bundled typings and @types/pg is not installed: a minimal
// local shape of the Client is typed below instead of adding a dependency.
import * as pgModule from 'pg';

/**
 * A dedicated Postgres connection running `LISTEN <channel>` (M5 W1-C,
 * item 4). Prisma pools its connections and never surfaces async
 * notifications, so cross-instance cache invalidation needs its own client.
 * The connection is re-established with a fixed back-off when it drops;
 * while it is down the caller falls back to its TTL. Nothing here throws:
 * a listener that cannot connect only logs a warning.
 */

interface PgClientLike {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<unknown>;
  on(
    event: 'notification',
    cb: (msg: { channel: string; payload?: string }) => void,
  ): void;
  on(event: 'error' | 'end', cb: (err?: Error) => void): void;
  removeAllListeners(): void;
}

type PgClientCtor = new (config: {
  connectionString: string;
  application_name?: string;
}) => PgClientLike;

const RECONNECT_MS = 30_000;

/** Prisma's `schema` query parameter is not a libpq option: drop it. */
export function stripPrismaParams(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = url
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== '' && !/^schema(=|$)/i.test(p));
  return params.length
    ? `${url.slice(0, q)}?${params.join('&')}`
    : url.slice(0, q);
}

export class PgNotifyListener {
  private readonly logger = new Logger(PgNotifyListener.name);
  private client: PgClientLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting = false;

  constructor(
    private readonly channel: string,
    private readonly onPayload: (payload: string) => void,
    private readonly databaseUrl: string | undefined = process.env.DATABASE_URL,
  ) {}

  /** Connected and listening right now. */
  get connected(): boolean {
    return this.client !== null;
  }

  /** Starts listening; returns immediately, the connection happens in the background. */
  start(): void {
    this.stopped = false;
    if (!this.databaseUrl) {
      this.logger.warn(
        `LISTEN ${this.channel} disabled: DATABASE_URL is not set`,
      );
      return;
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.client) return;
    this.connecting = true;
    const Client = (pgModule as unknown as { Client: PgClientCtor }).Client;
    const client = new Client({
      connectionString: stripPrismaParams(this.databaseUrl as string),
      application_name: `multi-stores-listen-${this.channel}`,
    });
    try {
      await client.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== this.channel || !msg.payload) return;
        try {
          this.onPayload(msg.payload);
        } catch (err) {
          this.logger.warn(
            `${this.channel} handler failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      const dropped = (err?: Error) => {
        if (this.client !== client) return;
        this.client = null;
        client.removeAllListeners();
        void client.end().catch(() => undefined);
        if (this.stopped) return;
        this.logger.warn(
          `LISTEN ${this.channel} connection lost${err ? `: ${err.message}` : ''}; retrying in ${RECONNECT_MS / 1000} s`,
        );
        this.scheduleReconnect();
      };
      client.on('error', dropped);
      client.on('end', dropped);
      await client.query(`LISTEN "${this.channel}"`);
      if (this.stopped) {
        client.removeAllListeners();
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.logger.log(`LISTEN ${this.channel} connected`);
    } catch (err) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
      if (!this.stopped) {
        this.logger.warn(
          `LISTEN ${this.channel} failed (${err instanceof Error ? err.message : String(err)}); TTL fallback, retry in ${RECONNECT_MS / 1000} s`,
        );
        this.scheduleReconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, RECONNECT_MS);
    // Never keep the event loop alive just to retry.
    this.timer.unref();
  }
}
