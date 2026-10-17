import type { BundleReader } from './bundle-reader';
import type {
  ImportSourceKindName,
  NormalizedCatalog,
  SourceCapabilities,
} from '../model/normalized';

/** Source settings stored on `ImportSource.settings` (M4.4 §3.2). */
export interface ImportSourceSettings {
  product_base?: string;
  category_base?: string;
  tag_base?: string;
  locale?: string;
  currency?: string;
  /** Uploads path on the source host, default `/wp-content/uploads/`. */
  uploads_path?: string;
}

/** What an adapter needs to know about the `ImportSource` row. */
export interface ImportSourceView {
  kind: ImportSourceKindName;
  /** Lower-case host without scheme/port, e.g. `namez.se`. */
  site_host: string;
  /** Hosts rewritten to `site_host` (Namez: `3dnamez.se`), D10. */
  host_aliases: string[];
  settings: ImportSourceSettings;
}

/**
 * Minimal fetcher contract an adapter may use (REST adapter). The SSRF-safe
 * implementation (`media/safe-fetch.ts`) belongs to WP-C and satisfies it.
 */
export interface AdapterFetcher {
  get(
    url: string,
    opts: {
      maxBytes: number;
      accept?: string;
      purpose: 'media' | 'rest';
      auth?: { user: string; pass: string };
    },
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
}

export interface AdapterLoadContext {
  source: ImportSourceView;
  bundle?: BundleReader;
  fetcher?: AdapterFetcher;
  signal?: AbortSignal;
  log?: (code: string, msg: string, data?: object) => void;
}

export interface SourceAdapter {
  readonly kind: ImportSourceKindName;
  capabilities(): SourceCapabilities;
  load(ctx: AdapterLoadContext): Promise<NormalizedCatalog>;
}

/** Error with an `IMPORT_*` code (mapped to an HTTP/run error by WP-C). */
export class ImportAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ImportAdapterError';
  }
}

/**
 * §9.3 catalog size limits (what the planner and apply are built for). The
 * 50 MB upload reaches about 3 000 products; the 20 000 ceiling is only
 * reachable through the admin from-directory run (200 MB), see
 * `runs/bundle-store.ts` and docs/DEPLOY-M4.md §7 (M5 B14).
 */
export const CATALOG_LIMITS = {
  products: 20_000,
  variations: 200_000,
  categories: 10_000,
  media: 5_000,
} as const;
