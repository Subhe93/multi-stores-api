/**
 * namez.shop translations (2026-11-20): writes the en/de/fr texts of the
 * translator files into store namez-se through the real services, in a
 * workers-off Nest application context (WORKERS=none). No raw SQL. Rules and
 * the plan: namez-shop-i18n-apply.planner.ts.
 *
 * Modes:
 *   --merge=A.json,B.json,C.json --out=translations.json
 *       merge the translator files (fails on a key with two values); no DB
 *   --file=translations.json --store=namez-se [--dry-run]   (default)
 *       print the plan and its fingerprint; no writes
 *   --file=... --store=... --apply --fingerprint=<hash> [--backup-dir=<dir>]
 *       re-plan, compare the fingerprint, write a backup of every entity it
 *       touches (before + after), then write entity by entity
 *   --restore=<backup.json> --store=... [--apply --fingerprint=<hash>] [--force]
 *       put every entity of a backup back to its `before` state (entities
 *       changed again after the apply are skipped unless --force)
 * Options: --overwrite (replace existing non-empty values of the SAME locale),
 *   --only-types=page,page_section,... , --publish-draft-changes (publish a
 *   page whose draft already differs from its published version),
 *   --snapshot=<file> (offline dry run against a snapshot JSON, no DB),
 *   --dump-snapshot=<file> (write the loaded snapshot), --verbose.
 *
 * Additive: values of locales that no record names are carried over
 * unchanged by every write; an existing different value of a named locale is
 * a conflict (skipped) unless --overwrite. Idempotent: a second run plans
 * nothing. Each touched page is published after its write (unless it was
 * never published). The storefront cache of the store is revalidated at the
 * end.
 *
 * The restore removes locale rows the apply created. For page translations,
 * page section translations and collection translations the services have no
 * delete-one-locale call, so those removals (restore only) are narrow Prisma
 * deleteMany calls on exactly those (parent id, locale) pairs.
 *
 * Run from the API directory with the production env loaded, e.g.
 *   node dist/prisma/scripts/namez-shop-i18n-apply.js --file=... --store=namez-se
 *   (or npx ts-node prisma/scripts/namez-shop-i18n-apply.ts ...)
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildPlan,
  buildRestorePlan,
  draftDiff,
  fingerprint,
  isNoop,
  mergeRecordSets,
  pageDiff,
  parseArgs,
  renderPlan,
  renderRestorePlan,
  restoreFingerprint,
  rowLocaleDiff,
  stableStringify,
  stateFromSnapshot,
  validateRecord,
  type BackupFile,
  type EntityChange,
  type EntityKind,
  type EntityState,
  type MenuNode,
  type Options,
  type Snapshot,
  type SnapPage,
  type TranslationRecord,
} from './namez-shop-i18n-apply.planner';

const DEFAULT_BACKUP_DIR = '/var/lib/multistores/backups';
const PUBLISH_LABEL = 'namez.shop translations 2026-11 (en/de/fr)';
const RESTORE_LABEL = 'namez.shop translations 2026-11: restore';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

// ── Files ───────────────────────────────────────────────────────────────────

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readRecords(file: string): TranslationRecord[] {
  const raw = readJson(file);
  if (!Array.isArray(raw)) throw new Error(`${file}: not an array`);
  const out: TranslationRecord[] = [];
  const bad: string[] = [];
  raw.forEach((r, i) => {
    const v = validateRecord(r);
    if (v.ok) out.push(v.record);
    else bad.push(`#${i}: ${v.reason}`);
  });
  if (bad.length)
    throw new Error(`${file}: ${bad.length} invalid record(s):\n  ${bad.slice(0, 20).join('\n  ')}`);
  return out;
}

function runMerge(o: Options): number {
  const res = mergeRecordSets(o.merge.map((f) => ({ source: f, records: readJson(f) })));
  for (const [src, n] of Object.entries(res.perSource)) console.log(`  ${src}: ${n} records`);
  console.log(`Merged: ${res.records.length} records, ${res.duplicates.length} identical duplicate(s) collapsed.`);
  if (res.invalid.length) {
    console.error(`INVALID (${res.invalid.length}):`);
    for (const i of res.invalid.slice(0, 50)) console.error(`  ${i.source} #${i.index}: ${i.reason}`);
  }
  if (res.conflicts.length) {
    console.error(`CONFLICTS (${res.conflicts.length}) — same key, different values:`);
    for (const c of res.conflicts.slice(0, 50)) console.error(`  ${c.key} (${c.sources.join(' vs ')})`);
  }
  if (res.invalid.length || res.conflicts.length) {
    console.error('Merge failed; nothing written.');
    return 1;
  }
  fs.writeFileSync(o.out!, JSON.stringify(res.records, null, 1) + '\n');
  console.log(`Wrote ${o.out}`);
  return 0;
}

function resolveBackupDir(o: Options): string {
  return o.backupDir || (process.env.MS_OPS_BACKUP_DIR || '').trim() || DEFAULT_BACKUP_DIR;
}

/** Creates the dir and proves it is writable (also in the dry run). */
function checkBackupDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, '', { mode: 0o600 });
  fs.unlinkSync(probe);
}

function writeBackup(file: string, backup: BackupFile): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(backup, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── Nest context ────────────────────────────────────────────────────────────

interface Ctx {
  app: Any;
  prisma: Any;
  products: Any;
  customFields: Any;
  faqs: Any;
  categories: Any;
  pages: Any;
  menus: Any;
  designer: Any;
  stores: Any;
  shipping: Any;
  revalidation: Any;
  buildPublishSnapshot: (page: Any) => Any;
  sectionOrder: Any;
  CREATOR: Any;
}

async function bootstrap(): Promise<Ctx> {
  // No schedulers or queue workers in this process (M5 W1-C switch); the
  // legacy per-worker flags win over WORKERS, so they are forced off too.
  process.env.WORKERS = 'none';
  for (const f of [
    'RETENTION_SCHEDULER',
    'BACKUP_SCHEDULER',
    'IMPORTER_WORKER',
    'DESIGNER_RENDER_QUEUE',
    'DESIGNER_WORKER',
  ])
    process.env[f] = 'off';
  // Loaded lazily (CommonJS require) so --merge and --snapshot runs never
  // load the Nest app graph or open a database connection.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = require('../../src/app.module');
  const { PrismaService } = require('../../src/prisma/prisma.service');
  const { ProductsService } = require('../../src/modules/products/products.service');
  const { CustomFieldsService } = require('../../src/modules/custom-fields/custom-fields.service');
  const { ProductFaqsService } = require('../../src/modules/product-faqs/product-faqs.service');
  const { CreatorCategoriesService } = require('../../src/modules/creator-categories/creator-categories.service');
  const pagesMod = require('../../src/modules/pages-v2/pages-v2.service');
  const { SECTION_READ_ORDER } = require('../../src/modules/pages-v2/page-snapshot');
  const { MenusService } = require('../../src/modules/menus/menus.service');
  const { DesignerTemplatesService } = require('../../src/modules/designer/designer-templates.service');
  const { StoresService } = require('../../src/modules/stores/stores.service');
  const { ShippingService } = require('../../src/modules/shipping/shipping.service');
  const { RevalidationService } = require('../../src/common/revalidation/revalidation.service');
  const { UserRole } = await import('@prisma/client');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const get = (t: Any) => app.get(t, { strict: false });
  return {
    app,
    prisma: get(PrismaService),
    products: get(ProductsService),
    customFields: get(CustomFieldsService),
    faqs: get(ProductFaqsService),
    categories: get(CreatorCategoriesService),
    pages: get(pagesMod.PagesV2Service),
    menus: get(MenusService),
    designer: get(DesignerTemplatesService),
    stores: get(StoresService),
    shipping: get(ShippingService),
    revalidation: get(RevalidationService),
    buildPublishSnapshot: pagesMod.buildPublishSnapshot,
    sectionOrder: SECTION_READ_ORDER,
    CREATOR: UserRole.CREATOR,
  };
}

interface StoreInfo {
  id: string;
  slug: string;
  creator_id: string;
  owner_user_id: string;
  primary_locale: string;
}

async function loadStore(ctx: Ctx, slug: string): Promise<StoreInfo> {
  const s = await ctx.prisma.store.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      creator_id: true,
      creator: { select: { user_id: true } },
      language_config: { select: { primary_locale: true } },
    },
  });
  if (!s) throw new Error(`Store "${slug}" not found.`);
  if (!s.creator?.user_id) throw new Error(`Store "${slug}" has no creator owner.`);
  return {
    id: s.id,
    slug: s.slug,
    creator_id: s.creator_id,
    owner_user_id: s.creator.user_id,
    primary_locale: s.language_config?.primary_locale ?? 'en',
  };
}

// ── Loader (reads only) ─────────────────────────────────────────────────────

interface Wanted {
  products: Set<string>;
  customFields: Set<string>;
  faqs: Set<string>;
  collections: Set<string>;
  templates: Set<string>;
  addons: Set<string>;
  shipping: Set<string>;
}

function wantedFromRecords(records: TranslationRecord[]): Wanted {
  const w: Wanted = {
    products: new Set(),
    customFields: new Set(),
    faqs: new Set(),
    collections: new Set(),
    templates: new Set(),
    addons: new Set(),
    shipping: new Set(),
  };
  for (const r of records) {
    if (r.type === 'product' || r.type === 'option_card') w.products.add(r.id);
    if (r.type === 'story' && r.product_id) w.products.add(r.product_id);
    if (r.type === 'custom_field') w.customFields.add(r.id);
    if (r.type === 'faq') w.faqs.add(r.id);
    if (r.type === 'collection') w.collections.add(r.id);
    if (r.type === 'designer_element' && r.template_id) w.templates.add(r.template_id);
    if (r.type === 'designer_addon') w.addons.add(r.id);
    if (r.type === 'shipping_method') w.shipping.add(r.id);
  }
  return w;
}

function wantedFromEntities(keys: { kind: EntityKind; id: string }[]): Wanted {
  const w = wantedFromRecords([]);
  for (const { kind, id } of keys) {
    if (kind === 'product' || kind === 'product_options' || kind === 'product_stories') w.products.add(id);
    if (kind === 'custom_field') w.customFields.add(id);
    if (kind === 'faq') w.faqs.add(id);
    if (kind === 'collection') w.collections.add(id);
    if (kind === 'designer_template') w.templates.add(id);
    if (kind === 'designer_addons') w.addons.add(id);
    if (kind === 'shipping_method') w.shipping.add(id);
  }
  return w;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const byLocale = <T extends { locale: string }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));

async function loadSnapshot(ctx: Ctx, store: StoreInfo, w: Wanted): Promise<Snapshot> {
  const p = ctx.prisma;
  const snap: Snapshot = {
    store: { id: store.id, slug: store.slug, primary_locale: store.primary_locale },
    products: {},
    custom_fields: {},
    faqs: {},
    collections: {},
    pages: {},
    menus: {},
    designer_templates: {},
    designer_addons: {},
    theme_config: null,
    shipping_methods: {},
  };

  const products = await p.product.findMany({
    where: { id: { in: [...w.products] }, creator_id: store.creator_id },
    select: {
      id: true,
      variant_option_config: true,
      translations: {
        select: {
          locale: true,
          title: true,
          slug: true,
          description: true,
          short_description: true,
          meta_title: true,
          meta_desc: true,
        },
      },
      stories: {
        orderBy: { sort_order: 'asc' },
        select: {
          id: true,
          kind: true,
          url: true,
          poster_url: true,
          duration_s: true,
          width: true,
          height: true,
          name: true,
          rating: true,
          verified: true,
          autoplay: true,
          loop: true,
          translations: { select: { locale: true, quote: true, subtitle: true } },
        },
      },
    },
  });
  for (const x of products)
    snap.products[x.id] = {
      id: x.id,
      translations: byLocale(x.translations),
      variant_option_config: x.variant_option_config ?? null,
      stories: x.stories.map((s: Any) => ({ ...s, translations: byLocale(s.translations) })),
    };

  const fields = await p.productCustomField.findMany({
    where: { id: { in: [...w.customFields] }, product: { creator_id: store.creator_id } },
    select: {
      id: true,
      product_id: true,
      translations: {
        select: {
          locale: true,
          label: true,
          placeholder: true,
          option_labels: true,
          display_label: true,
          sublabel: true,
          note: true,
          help_text: true,
          help_image_url: true,
          messages: true,
        },
      },
    },
  });
  for (const f of fields)
    snap.custom_fields[f.id] = { id: f.id, product_id: f.product_id, translations: byLocale(f.translations) };

  const faqs = await p.productFaq.findMany({
    where: { id: { in: [...w.faqs] }, product: { creator_id: store.creator_id } },
    select: {
      id: true,
      product_id: true,
      translations: { select: { locale: true, question: true, answer: true } },
    },
  });
  for (const f of faqs)
    snap.faqs[f.id] = { id: f.id, product_id: f.product_id, translations: byLocale(f.translations) };

  const cats = await p.creatorCategory.findMany({
    where: { id: { in: [...w.collections] }, creator_id: store.creator_id },
    select: {
      id: true,
      translations: {
        select: {
          locale: true,
          name: true,
          description: true,
          long_description: true,
          meta_title: true,
          meta_desc: true,
        },
      },
    },
  });
  for (const c of cats) snap.collections[c.id] = { id: c.id, translations: byLocale(c.translations) };

  // Every page of the store: page_section records carry no page id.
  const pages = await p.page.findMany({
    where: { store_id: store.id },
    include: {
      translations: true,
      sections: { include: { translations: true }, orderBy: ctx.sectionOrder },
      published_version: { select: { id: true, snapshot: true } },
    },
  });
  for (const pg of pages) {
    const sp: SnapPage = {
      id: pg.id,
      slug: pg.slug,
      type: pg.type,
      published: !!pg.published_version,
      draft_diff: pg.published_version
        ? draftDiff(ctx.buildPublishSnapshot(pg), pg.published_version.snapshot)
        : [],
      translations: byLocale(
        pg.translations.map((t: Any) => ({
          locale: t.locale,
          title: t.title,
          meta_title: t.meta_title,
          meta_description: t.meta_description,
        })),
      ),
      sections: pg.sections.map((s: Any) => ({
        id: s.id,
        section_key: s.section_key,
        translations: byLocale(
          s.translations.map((t: Any) => ({ locale: t.locale, content: obj(t.content) })),
        ),
      })),
    };
    snap.pages[pg.id] = sp;
  }

  const menus = await p.menu.findMany({
    where: { store_id: store.id },
    select: { id: true, items: { orderBy: { sort_order: 'asc' } } },
  });
  for (const m of menus) {
    const nodes = new Map<string, MenuNode & { parent_id: string | null }>();
    for (const it of m.items)
      nodes.set(it.id, {
        id: it.id,
        kind: it.kind,
        resource_id: it.resource_id,
        label: it.label,
        label_i18n: obj(it.label_i18n) as Record<string, string>,
        url: it.url,
        open_in_new_tab: it.open_in_new_tab,
        children: [],
        parent_id: it.parent_id,
      });
    const roots: MenuNode[] = [];
    for (const n of nodes.values()) {
      const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
      (parent ? parent.children : roots).push(n);
    }
    const strip = (list: MenuNode[]): MenuNode[] =>
      list.map((n) => {
        const { parent_id: _p, ...rest } = n as MenuNode & { parent_id?: string | null };
        void _p;
        return { ...rest, children: strip(n.children) };
      });
    snap.menus[m.id] = { id: m.id, items: strip(roots) };
  }

  const templates = await p.designTemplate.findMany({
    where: { id: { in: [...w.templates] }, store_id: store.id },
    select: { id: true, current_version_id: true },
  });
  for (const t of templates) {
    const v = t.current_version_id
      ? await p.designTemplateVersion.findFirst({
          where: { id: t.current_version_id, template_id: t.id },
          select: { spec: true },
        })
      : null;
    snap.designer_templates[t.id] = {
      id: t.id,
      current_version_id: t.current_version_id,
      spec: v?.spec ?? null,
    };
  }

  const links = await p.productDesigner.findMany({
    where: { product_id: { in: [...w.addons] }, store_id: store.id },
    select: { product_id: true, addons: true },
  });
  for (const l of links) snap.designer_addons[l.product_id] = { product_id: l.product_id, addons: l.addons };

  const st = await p.store.findUnique({ where: { id: store.id }, select: { theme_config: true } });
  snap.theme_config = obj(st?.theme_config);

  const methods = await p.shippingMethod.findMany({
    where: { id: { in: [...w.shipping] }, zone: { profile: { creator_id: store.creator_id } } },
    select: { id: true, name: true, translations: true },
  });
  for (const m of methods)
    snap.shipping_methods[m.id] = {
      id: m.id,
      name: m.name,
      translations: m.translations ? (obj(m.translations) as Record<string, string>) : null,
    };
  return snap;
}

// ── Writers (service calls) ─────────────────────────────────────────────────

const orUndef = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

function menuDto(to: MenuNode[], from: MenuNode[]): Any[] {
  const old = new Map<string, MenuNode>();
  const walk = (l: MenuNode[]) => l.forEach((n) => (old.set(n.id, n), walk(n.children)));
  walk(from);
  const build = (list: MenuNode[]): Any[] =>
    list.map((n) => {
      // Locales the target state drops are sent as null (cleared).
      const prev = old.get(n.id)?.label_i18n ?? {};
      const label_i18n: Record<string, string | null> = { ...n.label_i18n };
      for (const l of Object.keys(prev)) if (!(l in n.label_i18n)) label_i18n[l] = null;
      return {
        id: n.id,
        kind: n.kind,
        resource_id: n.resource_id,
        label: n.label,
        label_i18n,
        url: n.url,
        open_in_new_tab: n.open_in_new_tab,
        children: build(n.children),
      };
    });
  return build(to);
}

async function writeEntity(
  ctx: Ctx,
  store: StoreInfo,
  c: EntityChange,
  mode: 'apply' | 'restore',
): Promise<void> {
  const uid = store.owner_user_id;
  const from = c.before as Any;
  const to = c.after as Any;
  const noRemoval = (removed: string[], what: string) => {
    if (mode === 'apply' && removed.length)
      throw new Error(`${what}: apply would remove locale(s) ${removed.join(', ')} (refused)`);
  };
  switch (c.kind) {
    case 'product': {
      noRemoval(rowLocaleDiff(from.translations, to.translations).removed, `product ${c.id}`);
      await ctx.products.update(c.id, uid, ctx.CREATOR, {
        // email_note is left undefined: the service keeps the stored value.
        translations: to.translations.map((r: Any) => ({
          locale: r.locale,
          title: r.title,
          slug: r.slug,
          description: r.description,
          meta_title: orUndef(r.meta_title),
          meta_desc: orUndef(r.meta_desc),
          short_description: r.short_description,
        })),
      });
      return;
    }
    case 'product_options':
      await ctx.products.update(c.id, uid, ctx.CREATOR, {
        variant_option_config: to.variant_option_config,
      });
      return;
    case 'product_stories':
      await ctx.products.update(c.id, uid, ctx.CREATOR, {
        stories: to.stories.map((s: Any) => ({
          id: s.id,
          kind: String(s.kind).toLowerCase(),
          url: s.url,
          poster_url: s.poster_url,
          duration_s: s.duration_s,
          width: s.width,
          height: s.height,
          name: s.name,
          rating: s.rating,
          verified: s.verified,
          autoplay: s.autoplay,
          loop: s.loop,
          translations: s.translations.map((t: Any) => ({
            locale: t.locale,
            quote: t.quote,
            subtitle: t.subtitle,
          })),
        })),
      });
      return;
    case 'custom_field': {
      noRemoval(rowLocaleDiff(from.translations, to.translations).removed, `custom field ${c.id}`);
      const rows = to.translations.map((r: Any) => {
        // Nulls are left out (Json columns reject a plain null on create).
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined) out[k] = v;
        return out;
      });
      await ctx.customFields.update(c.id, { translations: rows }, uid, ctx.CREATOR);
      return;
    }
    case 'faq':
      noRemoval(rowLocaleDiff(from.translations, to.translations).removed, `faq ${c.id}`);
      await ctx.faqs.update(
        c.id,
        { translations: to.translations.map((r: Any) => ({ locale: r.locale, question: r.question, answer: r.answer })) },
        { id: uid, role: ctx.CREATOR },
      );
      return;
    case 'collection': {
      const d = rowLocaleDiff(from.translations, to.translations);
      noRemoval(d.removed, `collection ${c.id}`);
      if (d.changed.length)
        await ctx.categories.update(c.id, uid, {
          translations: to.translations.filter((r: Any) => d.changed.includes(r.locale)),
        });
      if (d.removed.length)
        await ctx.prisma.creatorCategoryTranslation.deleteMany({
          where: { creator_category_id: c.id, locale: { in: d.removed } },
        });
      return;
    }
    case 'page': {
      const d = pageDiff(from.page, to.page);
      noRemoval(d.translations.removed, `page ${c.id} translations`);
      for (const s of d.sections) noRemoval(s.removed, `section ${s.id}`);
      if (d.translations.changed.length)
        await ctx.pages.update(uid, c.id, {
          translations: to.page.translations.filter((r: Any) => d.translations.changed.includes(r.locale)),
        });
      if (d.translations.removed.length)
        await ctx.prisma.pageTranslation.deleteMany({
          where: { page_id: c.id, locale: { in: d.translations.removed } },
        });
      for (const s of d.sections) {
        const section = to.page.sections.find((x: Any) => x.id === s.id);
        if (s.changed.length)
          await ctx.pages.updateSection(uid, s.id, {
            translations: section.translations
              .filter((t: Any) => s.changed.includes(t.locale))
              .map((t: Any) => ({ locale: t.locale, content: t.content })),
          });
        if (s.removed.length)
          await ctx.prisma.pageSectionTranslation.deleteMany({
            where: { section_id: s.id, locale: { in: s.removed } },
          });
      }
      if (c.publish)
        await ctx.pages.publish(uid, c.id, { label: mode === 'apply' ? PUBLISH_LABEL : RESTORE_LABEL });
      return;
    }
    case 'menu':
      await ctx.menus.setItems(uid, c.id, { items: menuDto(to.items, from.items) });
      return;
    case 'designer_template': {
      // Versions are immutable: reuse the target version when its spec is the
      // target spec (restore), else add a version; then publish it.
      let versionId: string | null = null;
      if (to.current_version_id) {
        const v = await ctx.prisma.designTemplateVersion.findFirst({
          where: { id: to.current_version_id, template_id: c.id },
          select: { spec: true },
        });
        if (v && stableStringify(v.spec) === stableStringify(to.spec)) versionId = to.current_version_id;
      }
      if (!versionId) versionId = (await ctx.designer.addVersion(store.id, c.id, to.spec, uid)).id;
      await ctx.designer.publish(store.id, c.id, versionId);
      return;
    }
    case 'designer_addons': {
      const a = obj(to.addons);
      if (a.v !== 2 || !Array.isArray(a.items))
        throw new Error(`designer add-ons of ${c.id}: not a v2 config`);
      await ctx.designer.putProductAddons(store.id, c.id, { v: 2, items: a.items });
      return;
    }
    case 'store_theme':
      await ctx.stores.updateTheme(uid, { theme_config: to.theme_config });
      return;
    case 'shipping_method':
      await ctx.shipping.updateMethod(
        c.id,
        { translations: to.translations ?? {} },
        store.creator_id,
        'creator',
      );
      return;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');

async function runApplyMode(o: Options): Promise<number> {
  const records = readRecords(o.file!);
  const opts = { overwrite: o.overwrite, publishDraftChanges: o.publishDraftChanges, onlyTypes: o.onlyTypes };
  console.log(`Records: ${records.length} from ${o.file}`);

  if (o.snapshot) {
    const snap = readJson(o.snapshot) as Snapshot;
    if (snap.store.slug !== o.store) throw new Error(`snapshot is for store ${snap.store.slug}`);
    const plan = buildPlan(snap, records, opts);
    console.log(renderPlan(plan, o.verbose));
    console.log(`\nFingerprint (offline snapshot, not valid for --apply): ${fingerprint(plan)}`);
    return 0;
  }

  const backupDir = resolveBackupDir(o);
  checkBackupDir(backupDir);
  const ctx = await bootstrap();
  try {
    const store = await loadStore(ctx, o.store!);
    const wanted = wantedFromRecords(records);
    const snap = await loadSnapshot(ctx, store, wanted);
    if (o.dumpSnapshot) {
      fs.writeFileSync(o.dumpSnapshot, JSON.stringify(snap, null, 1), { mode: 0o600 });
      console.log(`Snapshot written to ${o.dumpSnapshot}`);
    }
    const plan = buildPlan(snap, records, opts);
    console.log(renderPlan(plan, o.verbose));
    const fp = fingerprint(plan);
    console.log(`\nFingerprint: ${fp}`);
    if (isNoop(plan)) {
      console.log('Nothing to write (already applied).');
      return 0;
    }
    if (o.mode === 'dry-run') {
      console.log(`\nDry run only. Apply with the same options plus: --apply --fingerprint=${fp}`);
      return 0;
    }
    if (o.fingerprint !== fp) {
      console.error(o.fingerprint ? `Fingerprint mismatch: given ${o.fingerprint}, planned ${fp}.` : '--apply needs --fingerprint=<hash> from the dry run.');
      return 1;
    }
    const file = path.join(backupDir, `namez-shop-i18n-${store.slug}-${stamp()}.json`);
    const backup: BackupFile = {
      format: 'namez-shop-i18n-backup/1',
      store: { id: store.id, slug: store.slug },
      created_at: new Date().toISOString(),
      fingerprint: fp,
      options: opts,
      entities: plan.changes.map((c) => ({ kind: c.kind, id: c.id, before: c.before, after: c.after, publish: c.publish })),
      applied: [],
    };
    writeBackup(file, backup);
    console.log(`\nBackup: ${file}`);
    let failed: unknown = null;
    for (const c of plan.changes) {
      try {
        await writeEntity(ctx, store, c, 'apply');
        backup.applied.push(`${c.kind}:${c.id}`);
        writeBackup(file, backup);
      } catch (err) {
        failed = err;
        console.error(`FAILED at ${c.kind}:${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    // Record what really is stored now (restore compares against it).
    const after = await loadSnapshot(ctx, store, wanted);
    for (const e of backup.entities) {
      if (!backup.applied.includes(`${e.kind}:${e.id}`)) continue;
      const now = stateFromSnapshot(after, e.kind, e.id);
      if (now) e.after = now;
    }
    writeBackup(file, backup);
    console.log(`Applied ${backup.applied.length}/${plan.changes.length} entities. Backup updated: ${file}`);
    await ctx.revalidation.revalidateStoreBySlug(store.slug);
    await ctx.revalidation.flush();
    console.log('Storefront cache revalidation requested.');
    if (failed) {
      console.error(`Stopped on an error. Undo with: --restore=${file} --store=${store.slug}`);
      return 1;
    }
    const again = buildPlan(after, records, opts);
    console.log(`Re-plan after apply: ${again.changes.length} entities left to write (expected 0).`);
    return 0;
  } finally {
    await ctx.app.close();
  }
}

async function runRestoreMode(o: Options): Promise<number> {
  const backup = readJson(o.restore!) as BackupFile;
  if (backup.format !== 'namez-shop-i18n-backup/1') throw new Error('not a namez-shop-i18n backup file');
  if (backup.store.slug !== o.store) throw new Error(`backup is for store ${backup.store.slug}`);
  const backupDir = resolveBackupDir(o);
  checkBackupDir(backupDir);
  const ctx = await bootstrap();
  try {
    const store = await loadStore(ctx, o.store!);
    if (store.id !== backup.store.id) throw new Error('store id differs from the backup');
    const wanted = wantedFromEntities(backup.entities);
    const snap = await loadSnapshot(ctx, store, wanted);
    const plan = buildRestorePlan(backup, (k, id) => stateFromSnapshot(snap, k, id), o.force);
    console.log(renderRestorePlan(plan));
    const fp = restoreFingerprint(plan);
    console.log(`\nFingerprint: ${fp}`);
    if (!plan.changes.length) {
      console.log('Nothing to restore.');
      return 0;
    }
    if (o.mode === 'dry-run') {
      console.log(`\nDry run only. Restore with the same options plus: --apply --fingerprint=${fp}`);
      return 0;
    }
    if (o.fingerprint !== fp) {
      console.error(o.fingerprint ? `Fingerprint mismatch: given ${o.fingerprint}, planned ${fp}.` : '--apply needs --fingerprint=<hash> from the dry run.');
      return 1;
    }
    // The restore is itself backed up (and restorable).
    const file = path.join(backupDir, `namez-shop-i18n-${store.slug}-restore-${stamp()}.json`);
    const own: BackupFile = {
      ...backup,
      created_at: new Date().toISOString(),
      fingerprint: fp,
      entities: plan.changes.map((c) => ({ kind: c.kind, id: c.id, before: c.before, after: c.after, publish: c.publish })),
      applied: [],
    };
    writeBackup(file, own);
    console.log(`Pre-restore backup: ${file}`);
    let code = 0;
    for (const c of plan.changes) {
      try {
        await writeEntity(ctx, store, c, 'restore');
        own.applied.push(`${c.kind}:${c.id}`);
        writeBackup(file, own);
      } catch (err) {
        console.error(`FAILED at ${c.kind}:${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        code = 1;
        break;
      }
    }
    console.log(`Restored ${own.applied.length}/${plan.changes.length} entities.`);
    await ctx.revalidation.revalidateStoreBySlug(store.slug);
    await ctx.revalidation.flush();
    return code;
  } finally {
    await ctx.app.close();
  }
}

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  if (o.merge.length) return runMerge(o);
  if (o.restore) return runRestoreMode(o);
  return runApplyMode(o);
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

export type { EntityState };
