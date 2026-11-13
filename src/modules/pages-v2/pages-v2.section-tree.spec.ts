import { BadRequestException } from '@nestjs/common';
import { PagesV2Service, buildPublishSnapshot } from './pages-v2.service';
import { buildPageSnapshot, SnapshotSourcePage } from './page-snapshot';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';

// Section tree (layout containers) on the pages-v2 service: add into a
// container, tree reorder validation, cascade delete, subtree duplicate,
// publish snapshot with parents / hidden containers, restore remap.

interface Tr {
  id: string;
  section_id: string;
  locale: string;
  content: Record<string, unknown>;
}
interface Sec {
  id: string;
  page_id: string;
  parent_id: string | null;
  section_key: string;
  settings: Record<string, unknown>;
  sort_order: number;
  is_hidden: boolean;
  created_at: Date;
  updated_at: Date;
}

type Where = Record<string, unknown>;
interface CreateData {
  page_id: string;
  parent_id?: string | null;
  section_key: string;
  settings?: Record<string, unknown>;
  sort_order?: number;
  is_hidden?: boolean;
  translations?: {
    create?: { locale: string; content: Record<string, unknown> }[];
  };
}

function fakeDb(pageType = 'PRODUCT_TEMPLATE') {
  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;
  const page: Record<string, unknown> = {
    id: 'p1',
    store_id: 's1',
    type: pageType,
    static_kind: null,
    slug: null,
    seo: {},
    status: 'DRAFT',
    published_version_id: null,
  };
  const sections: Sec[] = [];
  const translations: Tr[] = [];
  const versions: Record<string, unknown>[] = [];

  const withTr = (s: Sec) => ({
    ...s,
    translations: translations.filter((t) => t.section_id === s.id),
  });
  const matches = (s: Sec, where: Where = {}) => {
    if (where.page_id !== undefined && s.page_id !== where.page_id)
      return false;
    if ('parent_id' in where && s.parent_id !== (where.parent_id ?? null))
      return false;
    const id = where.id as string | { in: string[] } | undefined;
    if (typeof id === 'string' && s.id !== id) return false;
    if (id && typeof id === 'object' && !id.in.includes(s.id)) return false;
    return true;
  };
  const removeCascade = (id: string) => {
    for (const child of sections.filter((s) => s.parent_id === id))
      removeCascade(child.id);
    const idx = sections.findIndex((s) => s.id === id);
    if (idx >= 0) sections.splice(idx, 1);
    for (let i = translations.length - 1; i >= 0; i--)
      if (translations[i].section_id === id) translations.splice(i, 1);
  };

  const pageSection = {
    findUnique: jest.fn(({ where }: { where: { id: string } }) => {
      const s = sections.find((x) => x.id === where.id);
      return Promise.resolve(
        s ? { ...s, page: { store_id: page.store_id } } : null,
      );
    }),
    findMany: jest.fn(({ where }: { where?: Where } = {}) =>
      Promise.resolve(
        sections
          .filter((s) => matches(s, where))
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(withTr),
      ),
    ),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(sections.filter((s) => matches(s, where)).length),
    ),
    create: jest.fn(({ data }: { data: CreateData }) => {
      const s: Sec = {
        id: nextId('sec'),
        page_id: data.page_id,
        parent_id: data.parent_id ?? null,
        section_key: data.section_key,
        settings: data.settings ?? {},
        sort_order: data.sort_order ?? 0,
        is_hidden: data.is_hidden ?? false,
        created_at: new Date(0),
        updated_at: new Date(0),
      };
      sections.push(s);
      for (const t of data.translations?.create ?? [])
        translations.push({
          id: nextId('tr'),
          section_id: s.id,
          locale: t.locale,
          content: t.content,
        });
      return Promise.resolve(withTr(s));
    }),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<Sec> }) => {
        const s = sections.find((x) => x.id === where.id);
        if (!s) return Promise.reject(new Error(`no section ${where.id}`));
        Object.assign(s, data);
        return Promise.resolve(withTr(s));
      },
    ),
    delete: jest.fn(({ where }: { where: { id: string } }) => {
      const s = sections.find((x) => x.id === where.id);
      removeCascade(where.id);
      return Promise.resolve(s);
    }),
    deleteMany: jest.fn(({ where }: { where: Where }) => {
      const ids = sections.filter((s) => matches(s, where)).map((s) => s.id);
      ids.forEach(removeCascade);
      return Promise.resolve({ count: ids.length });
    }),
  };

  const fullPage = () => ({
    ...page,
    translations: [],
    sections: sections
      .filter((s) => s.page_id === page.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(withTr),
  });

  const db = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
    page: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === page.id ? fullPage() : null),
      ),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({
          ...fullPage(),
          published_version: versions[versions.length - 1] ?? null,
        }),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(page, data);
        return Promise.resolve(fullPage());
      }),
    },
    pageVersion: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const v = { id: nextId('v'), ...data };
        versions.push(v);
        return Promise.resolve(v);
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(versions.find((v) => v.id === where.id) ?? null),
      ),
    },
    pageTranslation: { upsert: jest.fn(() => Promise.resolve({})) },
    pageSection,
    $transaction: jest.fn(
      (arg: unknown): Promise<unknown> =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(db)
          : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  return { db, page, sections, translations, versions };
}

function makeService(pageType?: string) {
  const fake = fakeDb(pageType);
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve(undefined)),
  } as unknown as RevalidationService;
  const service = new PagesV2Service(
    fake.db as unknown as PrismaService,
    revalidation,
  );
  return { ...fake, service };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BadRequestException)
      return (e.getResponse() as { code?: string }).code;
    throw e;
  }
  return undefined;
}

/** Builds row > [col1 > gallery, col2 > title] + tabs on a product template. */
async function seedTree(service: PagesV2Service) {
  const row = await service.addSection('u', 'p1', {
    section_key: 'layout-row',
  });
  const col1 = await service.addSection('u', 'p1', {
    section_key: 'layout-column',
    parent_id: row.id,
  });
  const col2 = await service.addSection('u', 'p1', {
    section_key: 'layout-column',
    parent_id: row.id,
  });
  const gallery = await service.addSection('u', 'p1', {
    section_key: 'product-gallery',
    parent_id: col1.id,
    translations: [{ locale: 'en', content: { heading: 'G' } }],
  });
  const title = await service.addSection('u', 'p1', {
    section_key: 'product-details',
    parent_id: col2.id,
  });
  const tabs = await service.addSection('u', 'p1', {
    section_key: 'product-tabs',
  });
  return { row, col1, col2, gallery, title, tabs };
}

describe('PagesV2Service section tree', () => {
  it('adds into a container with sibling-scoped sort_order', async () => {
    const { service } = makeService();
    const t = await seedTree(service);
    expect(t.row).toMatchObject({ parent_id: null, sort_order: 0 });
    expect(t.col1).toMatchObject({ parent_id: t.row.id, sort_order: 0 });
    expect(t.col2).toMatchObject({ parent_id: t.row.id, sort_order: 1 });
    expect(t.gallery).toMatchObject({ parent_id: t.col1.id, sort_order: 0 });
    // Root count ignores children: the row is root #0, tabs root #1.
    expect(t.tabs).toMatchObject({ parent_id: null, sort_order: 1 });
  });

  it('keeps flat pages appending by page count as before', async () => {
    const { service } = makeService('HOME');
    const a = await service.addSection('u', 'p1', {
      section_key: 'hero-banner',
    });
    const b = await service.addSection('u', 'p1', { section_key: 'rich-text' });
    expect([a.sort_order, b.sort_order]).toEqual([0, 1]);
    expect(a.parent_id).toBeNull();
  });

  it('rejects containers on pages that do not allow them', async () => {
    const { service } = makeService('HOME');
    expect(
      await codeOf(
        service.addSection('u', 'p1', { section_key: 'layout-row' }),
      ),
    ).toBe('PAGE_SECTION_CONTAINER_NOT_ALLOWED');
  });

  it('rejects a non-container or foreign parent and too-deep nesting', async () => {
    const { service } = makeService();
    const t = await seedTree(service);
    expect(
      await codeOf(
        service.addSection('u', 'p1', {
          section_key: 'rich-text',
          parent_id: t.tabs.id,
        }),
      ),
    ).toBe('PAGE_SECTION_PARENT_NOT_CONTAINER');
    expect(
      await codeOf(
        service.addSection('u', 'p1', {
          section_key: 'rich-text',
          parent_id: 'not-here',
        }),
      ),
    ).toBe('PAGE_SECTION_PARENT_INVALID');
    // A container inside a column would sit at depth 3.
    expect(
      await codeOf(
        service.addSection('u', 'p1', {
          section_key: 'layout-grid',
          parent_id: t.col1.id,
        }),
      ),
    ).toBe('PAGE_SECTION_TREE_TOO_DEEP');
  });

  it('lists sections in depth-first tree order with parent_id', async () => {
    const { service } = makeService();
    const t = await seedTree(service);
    const list = await service.listSections('u', 'p1');
    expect(list.map((s) => s.id)).toEqual([
      t.row.id,
      t.col1.id,
      t.gallery.id,
      t.col2.id,
      t.title.id,
      t.tabs.id,
    ]);
    const page = await service.getById('u', 'p1');
    expect(page?.sections.map((s) => s.parent_id)).toEqual([
      null,
      t.row.id,
      t.col1.id,
      t.row.id,
      t.col2.id,
      null,
    ]);
  });

  it('tree reorder moves a section between containers in one transaction', async () => {
    const { service, db } = makeService();
    const t = await seedTree(service);
    db.$transaction.mockClear();
    const list = await service.reorderSectionTree('u', 'p1', {
      items: [
        { id: t.row.id, parent_id: null, sort_order: 0 },
        { id: t.col1.id, parent_id: t.row.id, sort_order: 0 },
        { id: t.col2.id, parent_id: t.row.id, sort_order: 1 },
        { id: t.gallery.id, parent_id: t.col1.id, sort_order: 0 },
        // Title moves under the gallery's column.
        { id: t.title.id, parent_id: t.col1.id, sort_order: 1 },
        { id: t.tabs.id, parent_id: null, sort_order: 1 },
      ],
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const title = list.find((s) => s.id === t.title.id);
    expect(title).toMatchObject({ parent_id: t.col1.id, sort_order: 1 });
  });

  it('tree reorder rejects cycles, foreign ids and missing ids without writing', async () => {
    const { service, db } = makeService();
    const t = await seedTree(service);
    const base = [
      { id: t.row.id, parent_id: null, sort_order: 0 },
      { id: t.col1.id, parent_id: t.row.id, sort_order: 0 },
      { id: t.col2.id, parent_id: t.row.id, sort_order: 1 },
      { id: t.gallery.id, parent_id: t.col1.id, sort_order: 0 },
      { id: t.title.id, parent_id: t.col2.id, sort_order: 0 },
      { id: t.tabs.id, parent_id: null, sort_order: 1 },
    ];
    db.pageSection.update.mockClear();
    const cycle = base.map((i) =>
      i.id === t.row.id ? { ...i, parent_id: t.col1.id } : i,
    );
    expect(
      await codeOf(service.reorderSectionTree('u', 'p1', { items: cycle })),
    ).toBe('PAGE_SECTION_TREE_CYCLE');
    expect(
      await codeOf(
        service.reorderSectionTree('u', 'p1', {
          items: [...base, { id: 'foreign', parent_id: null, sort_order: 9 }],
        }),
      ),
    ).toBe('PAGE_SECTION_IDS_INVALID');
    expect(
      await codeOf(
        service.reorderSectionTree('u', 'p1', { items: base.slice(1) }),
      ),
    ).toBe('PAGE_SECTION_IDS_INVALID');
    expect(db.pageSection.update).not.toHaveBeenCalled();
  });

  it('legacy flat reorder renumbers per sibling group', async () => {
    const { service } = makeService();
    const t = await seedTree(service);
    const list = await service.reorderSections('u', 'p1', {
      section_ids: [
        t.tabs.id,
        t.row.id,
        t.col2.id,
        t.title.id,
        t.col1.id,
        t.gallery.id,
      ],
    });
    const by = new Map(list.map((s) => [s.id, s]));
    expect(by.get(t.tabs.id)?.sort_order).toBe(0);
    expect(by.get(t.row.id)?.sort_order).toBe(1);
    expect(by.get(t.col2.id)?.sort_order).toBe(0);
    expect(by.get(t.col1.id)?.sort_order).toBe(1);
    expect(by.get(t.title.id)?.parent_id).toBe(t.col2.id);
  });

  it('deleting a container removes its descendants', async () => {
    const { service, sections, translations } = makeService();
    const t = await seedTree(service);
    await service.deleteSection('u', t.row.id);
    expect(sections.map((s) => s.id)).toEqual([t.tabs.id]);
    expect(translations).toHaveLength(0);
  });

  it('duplicates a subtree right after the original among its siblings', async () => {
    const { service } = makeService();
    const t = await seedTree(service);
    const list = await service.duplicateSection('u', t.col1.id);
    const cols = list
      .filter((s) => s.parent_id === t.row.id)
      .sort((a, b) => a.sort_order - b.sort_order);
    expect(cols.map((c) => c.sort_order)).toEqual([0, 1, 2]);
    expect(cols[0].id).toBe(t.col1.id);
    expect(cols[2].id).toBe(t.col2.id);
    const copy = cols[1];
    expect(copy.section_key).toBe('layout-column');
    const copyKids = list.filter((s) => s.parent_id === copy.id);
    expect(copyKids).toHaveLength(1);
    expect(copyKids[0]).toMatchObject({
      section_key: 'product-gallery',
      sort_order: 0,
    });
    expect(copyKids[0].id).not.toBe(t.gallery.id);
    expect(copyKids[0].translations).toEqual([
      expect.objectContaining({ locale: 'en', content: { heading: 'G' } }),
    ]);
    // The original subtree is untouched.
    expect(list.find((s) => s.id === t.gallery.id)?.parent_id).toBe(t.col1.id);
  });

  it('duplicates a root section after it and shifts later roots', async () => {
    const { service } = makeService();
    const t = await seedTree(service);
    const list = await service.duplicateSection('u', t.row.id);
    const roots = list.filter((s) => s.parent_id === null);
    expect(roots.map((r) => r.section_key)).toEqual([
      'layout-row',
      'layout-row',
      'product-tabs',
    ]);
    expect(roots.map((r) => r.sort_order)).toEqual([0, 1, 2]);
    // 6 originals + 5 copies (row, 2 columns, gallery, title).
    expect(list).toHaveLength(11);
  });

  it('publish snapshot carries parent_id and drops hidden subtrees', async () => {
    const { service, sections, versions } = makeService();
    const t = await seedTree(service);
    sections.find((s) => s.id === t.col2.id)!.is_hidden = true;
    await service.publish('u', 'p1', {});
    const snap = versions[0].snapshot as ReturnType<
      typeof buildPublishSnapshot
    >;
    expect(snap.sections.map((s) => s.id)).toEqual([
      t.row.id,
      t.col1.id,
      t.gallery.id,
      t.tabs.id,
    ]);
    expect(snap.sections.map((s) => s.parent_id)).toEqual([
      null,
      t.row.id,
      t.col1.id,
      null,
    ]);
    expect(snap.sections[0]).not.toHaveProperty('is_hidden');
  });

  it('publish snapshot of a flat page is unchanged apart from parent_id', async () => {
    const { service, versions } = makeService('HOME');
    await service.addSection('u', 'p1', { section_key: 'hero-banner' });
    await service.addSection('u', 'p1', { section_key: 'rich-text' });
    await service.publish('u', 'p1', {});
    const snap = versions[0].snapshot as ReturnType<
      typeof buildPublishSnapshot
    >;
    expect(
      snap.sections.map((s) => [s.section_key, s.sort_order, s.parent_id]),
    ).toEqual([
      ['hero-banner', 0, null],
      ['rich-text', 1, null],
    ]);
  });

  it('restore recreates the tree with fresh, remapped parent ids', async () => {
    const { service, versions, db } = makeService();
    const t = await seedTree(service);
    // A draft restore point (keeps hidden flags).
    await db.pageSection.update({
      where: { id: t.title.id },
      data: { is_hidden: true },
    });
    const current = (await db.page.findUnique({
      where: { id: 'p1' },
    })) as unknown as SnapshotSourcePage;
    const snapshot = buildPageSnapshot(current, 'draft');
    versions.push({ id: 'vr', page_id: 'p1', snapshot });

    const restored = await service.restoreVersion('u', 'p1', 'vr');
    const secs = restored!.sections;
    expect(secs).toHaveLength(6);
    const oldIds = new Set(Object.values(t).map((s) => s.id));
    expect(secs.some((s) => oldIds.has(s.id))).toBe(false);
    const row = secs.find((s) => s.section_key === 'layout-row')!;
    const cols = secs.filter((s) => s.parent_id === row.id);
    expect(cols.map((c) => c.sort_order)).toEqual([0, 1]);
    const gallery = secs.find((s) => s.section_key === 'product-gallery')!;
    expect(gallery.parent_id).toBe(cols[0].id);
    const title = secs.find((s) => s.section_key === 'product-details')!;
    expect(title).toMatchObject({ parent_id: cols[1].id, is_hidden: true });
  });

  it('restore of a pre-container snapshot keeps every section at the root', async () => {
    const { service, versions } = makeService('HOME');
    versions.push({
      id: 'old',
      page_id: 'p1',
      snapshot: {
        page: { seo: {}, translations: [] },
        sections: [
          {
            id: 'x',
            section_key: 'hero-banner',
            settings: {},
            sort_order: 0,
            translations: [],
          },
          {
            id: 'y',
            section_key: 'rich-text',
            settings: {},
            sort_order: 1,
            translations: [],
          },
        ],
      },
    });
    const restored = await service.restoreVersion('u', 'p1', 'old');
    expect(
      restored!.sections.map((s) => [
        s.section_key,
        s.sort_order,
        s.parent_id,
        s.is_hidden,
      ]),
    ).toEqual([
      ['hero-banner', 0, null, false],
      ['rich-text', 1, null, false],
    ]);
  });
});
