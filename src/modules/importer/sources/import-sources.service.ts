import { Inject, Injectable } from '@nestjs/common';
import { ImportSourceKind, Prisma, type ImportSource } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../../common/storage/private-file-storage';
import { normalizeSiteHost } from '../model/external-ref';
import { importError, isUniqueViolation } from '../importer.errors';
import { SafeFetcher, SafeFetchError } from '../media/safe-fetch';
import { ACTIVE_RUN_STATUSES } from '../runs/run-state';
import { deleteBundle } from '../runs/bundle-store';
import type {
  CreateImportSourceDto,
  UpdateImportSourceDto,
} from '../dto/source.dto';

/** Source view for the dashboard: secrets are write-only (`has_credentials`). */
export interface ImportSourceView {
  id: string;
  kind: ImportSourceKind;
  name: string;
  site_host: string;
  host_aliases: string[];
  settings: Record<string, unknown>;
  has_credentials: boolean;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SETTINGS_KEYS = [
  'product_base',
  'category_base',
  'tag_base',
  'locale',
  'currency',
  'uploads_path',
] as const;

export function toSourceView(s: ImportSource): ImportSourceView {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    site_host: s.site_host,
    host_aliases: s.host_aliases ?? [],
    settings: (s.settings ?? {}) as Record<string, unknown>,
    has_credentials: !!s.credentials_enc,
    last_verified_at: s.last_verified_at,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function hostOf(input: string): string {
  try {
    return normalizeSiteHost(input);
  } catch {
    throw importError(
      'IMPORT_SOURCE_HOST_INVALID',
      'Enter the shop address, e.g. https://example.com',
    );
  }
}

const UPLOADS_PATH_RE = /^\/[\w/-]+\/$/;

/**
 * `uploads_path` is joined into media URLs on the source host: it must be a
 * plain absolute directory path (`/wp-content/...` or `^/[\w/-]+/$`), never
 * `/` itself and never with dots, queries or schemes.
 */
export function isValidUploadsPath(v: string): boolean {
  if (v === '/' || v.includes('//') || v.length > 200) return false;
  if (v.startsWith('/wp-content/')) return /^\/wp-content\/[\w/-]*$/.test(v);
  return UPLOADS_PATH_RE.test(v);
}

export function cleanSettings(
  input: Record<string, unknown> | undefined,
): Prisma.InputJsonValue {
  const out: Record<string, string> = {};
  for (const k of SETTINGS_KEYS) {
    const v = input?.[k];
    if (typeof v === 'string' && v.trim() !== '')
      out[k] = v.trim().slice(0, 200);
  }
  if (out.uploads_path !== undefined && !isValidUploadsPath(out.uploads_path)) {
    throw importError(
      'IMPORT_SOURCE_SETTINGS_INVALID',
      'The uploads path must look like /wp-content/uploads/',
      { field: 'uploads_path' },
    );
  }
  return out;
}

/** Import sources of a store (M4.4 §10 `sources`). */
@Injectable()
export class ImportSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
  ) {}

  async list(storeId: string): Promise<ImportSourceView[]> {
    const rows = await this.prisma.importSource.findMany({
      where: { store_id: storeId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map(toSourceView);
  }

  async get(storeId: string, id: string): Promise<ImportSource> {
    const row = await this.prisma.importSource.findFirst({
      where: { id, store_id: storeId },
    });
    if (!row)
      throw importError('IMPORT_SOURCE_NOT_FOUND', 'Import source not found');
    return row;
  }

  /** Runs accept bundle sources only (WC_REST is not importable yet). */
  async assertBundleKind(storeId: string, id: string): Promise<ImportSource> {
    const source = await this.get(storeId, id);
    if (source.kind !== ImportSourceKind.WP_BUNDLE) {
      throw importError(
        'IMPORT_SOURCE_KIND_UNSUPPORTED',
        'Only WordPress export bundles can be imported in this version',
      );
    }
    return source;
  }

  private credentials(dto: {
    consumer_key?: string;
    consumer_secret?: string;
  }): string | null | undefined {
    if (dto.consumer_key === undefined && dto.consumer_secret === undefined)
      return undefined;
    if (!dto.consumer_key || !dto.consumer_secret) return null;
    return this.crypto.encrypt(`${dto.consumer_key}:${dto.consumer_secret}`);
  }

  async create(
    storeId: string,
    dto: CreateImportSourceDto,
  ): Promise<ImportSourceView> {
    const site_host = hostOf(dto.site_url);
    const aliases = [...new Set((dto.host_aliases ?? []).map(hostOf))].filter(
      (h) => h !== site_host,
    );
    const creds = this.credentials(dto);
    try {
      const row = await this.prisma.importSource.create({
        data: {
          store_id: storeId,
          kind: dto.kind,
          name: dto.name.trim(),
          site_host,
          host_aliases: aliases,
          settings: cleanSettings(dto.settings),
          credentials_enc: creds ?? null,
        },
      });
      return toSourceView(row);
    } catch (e) {
      if (isUniqueViolation(e))
        throw importError(
          'IMPORT_SOURCE_DUPLICATE',
          'A source for this shop already exists',
        );
      throw e;
    }
  }

  async update(
    storeId: string,
    id: string,
    dto: UpdateImportSourceDto,
  ): Promise<ImportSourceView> {
    const cur = await this.get(storeId, id);
    const site_host =
      dto.site_url !== undefined ? hostOf(dto.site_url) : cur.site_host;
    const aliases =
      dto.host_aliases !== undefined
        ? [...new Set(dto.host_aliases.map(hostOf))].filter(
            (h) => h !== site_host,
          )
        : cur.host_aliases;
    const creds = this.credentials(dto);
    // A key belongs to one shop: moving the source to another host drops the
    // saved key (unless new keys come with the change) and the verification.
    const hostChanged = site_host !== cur.site_host;
    const credsUpdate =
      creds !== undefined
        ? { credentials_enc: creds, last_verified_at: null }
        : hostChanged
          ? { credentials_enc: null, last_verified_at: null }
          : {};
    const settings =
      dto.settings !== undefined ? cleanSettings(dto.settings) : undefined;
    try {
      const row = await this.prisma.importSource.update({
        where: { id: cur.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          site_host,
          host_aliases: aliases,
          ...(settings !== undefined ? { settings } : {}),
          ...credsUpdate,
        },
      });
      return toSourceView(row);
    } catch (e) {
      if (isUniqueViolation(e))
        throw importError(
          'IMPORT_SOURCE_DUPLICATE',
          'A source for this shop already exists',
        );
      throw e;
    }
  }

  /** Refused while a run of the source is active; removes the runs' files (the ledger stays). */
  async remove(storeId: string, id: string): Promise<{ deleted: true }> {
    const cur = await this.get(storeId, id);
    const runs = await this.prisma.importRun.findMany({
      where: { source_id: cur.id },
      select: { status: true, bundle_key: true, snapshot_key: true },
    });
    if (runs.some((r) => ACTIVE_RUN_STATUSES.includes(r.status))) {
      throw importError(
        'IMPORT_SOURCE_IN_USE',
        'A run of this source is in progress',
      );
    }
    for (const r of runs) {
      if (r.bundle_key) await deleteBundle(this.storage, r.bundle_key);
      if (r.snapshot_key)
        await this.storage.delete(r.snapshot_key).catch(() => false);
    }
    await this.prisma.importSource.delete({ where: { id: cur.id } });
    return { deleted: true };
  }

  /** REST: `GET wc/v3/settings/general` with the saved Read key; bundle: nothing to verify. */
  async verify(
    storeId: string,
    id: string,
    fetcher?: SafeFetcher,
  ): Promise<ImportSourceView> {
    const cur = await this.get(storeId, id);
    if (cur.kind === ImportSourceKind.WP_BUNDLE) return toSourceView(cur);
    const plain = this.crypto.decrypt(cur.credentials_enc);
    const sep = plain?.indexOf(':') ?? -1;
    if (!plain || sep < 1) {
      throw importError(
        'IMPORT_SOURCE_CREDENTIALS_INVALID',
        'Save the consumer key and secret first',
      );
    }
    const f =
      fetcher ??
      new SafeFetcher({ siteHost: cur.site_host, aliases: cur.host_aliases });
    try {
      const res = await f.get(
        `https://${cur.site_host}/wp-json/wc/v3/settings/general`,
        {
          maxBytes: 1024 * 1024,
          accept: 'application/json',
          purpose: 'rest',
          auth: { user: plain.slice(0, sep), pass: plain.slice(sep + 1) },
        },
      );
      if (res.status === 401 || res.status === 403) {
        throw importError(
          'IMPORT_SOURCE_CREDENTIALS_INVALID',
          'The shop rejected the key',
        );
      }
      if (res.status !== 200) {
        throw importError(
          'IMPORT_SOURCE_CREDENTIALS_INVALID',
          `The shop answered HTTP ${res.status}`,
        );
      }
    } catch (e) {
      if (e instanceof SafeFetchError) throw importError(e.code, e.message);
      throw e;
    }
    const row = await this.prisma.importSource.update({
      where: { id: cur.id },
      data: { last_verified_at: new Date() },
    });
    return toSourceView(row);
  }
}
