import { Prisma, type StaticPageType } from '@prisma/client';
import {
  STORE_LEGAL_KIND,
  STORE_LEGAL_SLUGS,
  type StoreLegalSlug,
} from './store-templates';
import { CONTAINER_SECTION_KEYS } from '../../pages-v2/section-tree';

/** Prisma surface the loader needs (service client or a transaction). */
export interface StoreLegalDb {
  page: Pick<Prisma.TransactionClient['page'], 'findMany'>;
  staticPage: Pick<Prisma.TransactionClient['staticPage'], 'findMany'>;
  $queryRaw: Prisma.TransactionClient['$queryRaw'];
}

/**
 * What the resolver needs from a published snapshot (see pages-v2
 * buildPublishSnapshot): the number of (visible) content sections (layout
 * containers not counted) and the page
 * titles per locale. Read with a JSON path query, never the whole snapshot.
 */
export interface PublishedVersionMeta {
  section_count: number;
  titles: { locale: string; title: string | null }[];
}

export interface LegalV2Row {
  id: string;
  slug: string | null;
  static_kind: StaticPageType | null;
  published_version_id: string | null;
  updated_at: Date;
  /** Live (draft) titles. */
  translations: { locale: string; title: string | null }[];
  published_version: { published_at: Date | null } | null;
  /** Null when the page has no published version. */
  published_meta: PublishedVersionMeta | null;
}

export interface LegalLegacyRow {
  id: string;
  slug: string;
  type: StaticPageType;
  status: string;
  updated_at: Date;
  translations: { locale: string; title: string; content: string | null }[];
}

export interface StoreLegalRows {
  v2: LegalV2Row[];
  legacy: LegalLegacyRow[];
}

/** The store page that stands for one legal slug (published or a draft). */
export interface ResolvedLegalPage {
  state: 'published' | 'draft' | 'none';
  system: 'v2' | 'legacy' | null;
  page: {
    id: string;
    slug: string | null;
    updated_at: Date;
    titles: { locale: string; title: string }[];
  } | null;
}

const LEGAL_KINDS = STORE_LEGAL_SLUGS.map((s) => STORE_LEGAL_KIND[s]);

interface VersionMetaRow {
  id: string;
  section_count: number | null;
  titles: unknown;
}

/**
 * Section count + titles of published versions, extracted in SQL so the
 * (possibly large) snapshot JSON never leaves the database.
 */
async function loadPublishedMeta(
  db: StoreLegalDb,
  versionIds: string[],
): Promise<Map<string, PublishedVersionMeta>> {
  if (versionIds.length === 0) return new Map();
  const rows = await db.$queryRaw<VersionMetaRow[]>`
    SELECT v.id,
      (CASE WHEN jsonb_typeof(v.snapshot->'sections') = 'array'
        THEN (
          SELECT count(*) FROM jsonb_array_elements(v.snapshot->'sections') AS s
          WHERE NOT COALESCE(s->>'section_key' IN (${Prisma.join([...CONTAINER_SECTION_KEYS])}), false)
        ) ELSE 0
      END)::int AS section_count,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('locale', t->>'locale', 'title', t->>'title'))
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v.snapshot->'page'->'translations') = 'array'
            THEN v.snapshot->'page'->'translations' ELSE '[]'::jsonb END
        ) AS t
      ), '[]'::jsonb) AS titles
    FROM "PageVersion" v
    WHERE v.id IN (${Prisma.join(versionIds)})`;
  const out = new Map<string, PublishedVersionMeta>();
  for (const r of rows) {
    const titles = Array.isArray(r.titles)
      ? (r.titles as { locale?: unknown; title?: unknown }[])
          .filter((t) => typeof t?.locale === 'string')
          .map((t) => ({
            locale: t.locale as string,
            title: typeof t.title === 'string' ? t.title : null,
          }))
      : [];
    out.set(r.id, { section_count: Number(r.section_count ?? 0), titles });
  }
  return out;
}

/**
 * Loads the store's legal-kind pages of both page systems: two row queries,
 * plus one JSON path query when a v2 page is published.
 */
export async function loadStoreLegalRows(
  db: StoreLegalDb,
  storeId: string,
): Promise<StoreLegalRows> {
  const [v2, legacy] = await Promise.all([
    db.page.findMany({
      where: {
        store_id: storeId,
        type: 'STATIC',
        static_kind: { in: LEGAL_KINDS },
      },
      select: {
        id: true,
        slug: true,
        static_kind: true,
        published_version_id: true,
        updated_at: true,
        translations: { select: { locale: true, title: true } },
        published_version: { select: { published_at: true } },
      },
    }),
    db.staticPage.findMany({
      where: { store_id: storeId, type: { in: LEGAL_KINDS } },
      select: {
        id: true,
        slug: true,
        type: true,
        status: true,
        updated_at: true,
        translations: {
          select: { locale: true, title: true, content: true },
        },
      },
      orderBy: { sort_order: 'asc' },
    }),
  ]);
  const meta = await loadPublishedMeta(
    db,
    v2.flatMap((p) => (p.published_version_id ? [p.published_version_id] : [])),
  );
  return {
    v2: v2.map((p) => ({
      ...p,
      published_meta: p.published_version_id
        ? (meta.get(p.published_version_id) ?? {
            section_count: 0,
            titles: [],
          })
        : null,
    })),
    legacy,
  };
}

/**
 * Whether a published v2 page shows something: its published snapshot has
 * at least one (visible) section. Hidden sections are left out of the
 * snapshot at publish time.
 */
export function snapshotHasSections(p: LegalV2Row): boolean {
  return (p.published_meta?.section_count ?? 0) > 0;
}

/** True when HTML has visible text (tags, `&nbsp;` and whitespace aside). */
export function hasVisibleText(html: string | null | undefined): boolean {
  if (!html) return false;
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .trim().length > 0
  );
}

function nonEmptyTitles(
  translations: { locale: string; title: string | null }[],
): { locale: string; title: string }[] {
  return translations
    .filter((t) => typeof t.title === 'string' && t.title.trim() !== '')
    .map((t) => ({ locale: t.locale, title: (t.title as string).trim() }));
}

/**
 * The store's own page for a legal slug (SPEC): (a) a v2 STATIC page of the
 * kind with a published snapshot, else (b) a PUBLISHED legacy StaticPage of
 * the kind with content in some locale; v2 wins. Without one, the draft that
 * would become it (a v2 page first, then a legacy page), else none.
 * A published v2 page is titled from its published snapshot (what the
 * storefront renders), falling back to the live translations.
 */
export function resolveLegalPage(
  slug: StoreLegalSlug,
  rows: StoreLegalRows,
): ResolvedLegalPage {
  const kind = STORE_LEGAL_KIND[slug];
  const v2 = rows.v2.find((p) => p.static_kind === kind) ?? null;
  const legacyOfKind = rows.legacy.filter((p) => p.type === kind);

  const v2Page = (p: LegalV2Row, published: boolean) => {
    const snapshot = published
      ? nonEmptyTitles(p.published_meta?.titles ?? [])
      : [];
    return {
      id: p.id,
      slug: p.slug,
      updated_at: p.published_version?.published_at ?? p.updated_at,
      titles: snapshot.length > 0 ? snapshot : nonEmptyTitles(p.translations),
    };
  };
  const legacyPage = (p: LegalLegacyRow) => ({
    id: p.id,
    slug: p.slug,
    updated_at: p.updated_at,
    titles: nonEmptyTitles(p.translations),
  });

  if (v2 && v2.published_version_id && v2.slug && snapshotHasSections(v2)) {
    return { state: 'published', system: 'v2', page: v2Page(v2, true) };
  }
  const legacyLive = legacyOfKind.find(
    (p) =>
      p.status === 'PUBLISHED' &&
      p.translations.some((t) => hasVisibleText(t.content)),
  );
  if (legacyLive) {
    return {
      state: 'published',
      system: 'legacy',
      page: legacyPage(legacyLive),
    };
  }
  if (v2) return { state: 'draft', system: 'v2', page: v2Page(v2, false) };
  if (legacyOfKind[0]) {
    return {
      state: 'draft',
      system: 'legacy',
      page: legacyPage(legacyOfKind[0]),
    };
  }
  return { state: 'none', system: null, page: null };
}

/** `pt-BR` / `PT_br` → `pt`. */
function baseOf(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0];
}

/**
 * The first title among `locales` (in order): each locale matched
 * case-insensitively (`pt-BR` = `pt-br`), then by base language (`pt`);
 * else any title, else null.
 */
export function pickPageTitle(
  titles: { locale: string; title: string }[],
  locales: ReadonlyArray<string | null | undefined>,
): string | null {
  for (const l of locales) {
    if (!l) continue;
    const lower = l.toLowerCase();
    const hit =
      titles.find((t) => t.locale.toLowerCase() === lower) ??
      titles.find((t) => baseOf(t.locale) === baseOf(l));
    if (hit) return hit.title;
  }
  return titles[0]?.title ?? null;
}
