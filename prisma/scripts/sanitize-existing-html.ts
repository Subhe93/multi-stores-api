/**
 * One-off clean-up: runs the creator HTML sanitizer
 * (`src/common/html/creator-html.ts`) over HTML that was stored before the
 * write-time sanitizing existed — product translations (description,
 * short_description), product FAQ answers, category and creator-collection
 * descriptions, store descriptions and legacy static page content.
 *
 * Dry-run by default: prints, per table, how many rows would change and
 * writes nothing. `--apply` writes the sanitized values. `--slug <store>`
 * limits the run to one store (its products, collections, pages and
 * description; global categories are skipped in that mode).
 *
 *   npx ts-node prisma/scripts/sanitize-existing-html.ts
 *   npx ts-node prisma/scripts/sanitize-existing-html.ts --slug namez
 *   npx ts-node prisma/scripts/sanitize-existing-html.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { sanitizeCreatorHtml } from '../../src/common/html/creator-html';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const slugIdx = args.indexOf('--slug');
const SLUG = slugIdx === -1 ? null : (args[slugIdx + 1] ?? null);
if (slugIdx !== -1 && !SLUG) {
  console.error('--slug needs a store slug');
  process.exit(1);
}

type Change = { id: string; data: Record<string, string | null> };

/** Sanitized values that differ from what is stored; empty when nothing changes. */
function diff(
  row: Record<string, unknown>,
  fields: readonly string[],
  nullable: boolean,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of fields) {
    const value = row[f];
    if (typeof value !== 'string') continue;
    const clean = sanitizeCreatorHtml(value);
    const next = clean ?? (nullable ? null : '');
    if (next !== value) out[f] = next;
  }
  return out;
}

async function run(
  label: string,
  rows: Record<string, unknown>[],
  fields: readonly string[],
  nullable: boolean,
  write: (change: Change) => Promise<unknown>,
): Promise<void> {
  const changes: Change[] = [];
  for (const row of rows) {
    const data = diff(row, fields, nullable);
    if (Object.keys(data).length) changes.push({ id: row.id as string, data });
  }
  console.log(
    `${label}: ${rows.length} rows scanned, ${changes.length} would change`,
  );
  if (!APPLY) return;
  for (const change of changes) await write(change);
  if (changes.length) console.log(`  -> ${changes.length} rows updated`);
}

async function main(): Promise<void> {
  console.log(APPLY ? 'Mode: APPLY (writing)' : 'Mode: dry-run (no writes)');

  let storeId: string | null = null;
  let creatorId: string | null = null;
  if (SLUG) {
    const store = await prisma.store.findUnique({
      where: { slug: SLUG },
      select: { id: true, creator_id: true },
    });
    if (!store) {
      console.error(`Store "${SLUG}" not found`);
      process.exit(1);
    }
    storeId = store.id;
    creatorId = store.creator_id;
    console.log(`Scope: store ${SLUG}`);
  }

  // Product translations (description NOT NULL, short_description nullable).
  const productRows = await prisma.productTranslation.findMany({
    where: creatorId ? { product: { creator_id: creatorId } } : {},
    select: { id: true, description: true, short_description: true },
  });
  await run(
    'ProductTranslation.description',
    productRows,
    ['description'],
    false,
    (c) =>
      prisma.productTranslation.update({ where: { id: c.id }, data: c.data }),
  );
  await run(
    'ProductTranslation.short_description',
    productRows,
    ['short_description'],
    true,
    (c) =>
      prisma.productTranslation.update({ where: { id: c.id }, data: c.data }),
  );

  const faqRows = await prisma.productFaqTranslation.findMany({
    where: creatorId ? { faq: { product: { creator_id: creatorId } } } : {},
    select: { id: true, answer: true },
  });
  await run('ProductFaqTranslation.answer', faqRows, ['answer'], false, (c) =>
    prisma.productFaqTranslation.update({ where: { id: c.id }, data: c.data }),
  );

  if (!SLUG) {
    const categoryRows = await prisma.categoryTranslation.findMany({
      select: { id: true, description: true },
    });
    await run(
      'CategoryTranslation.description',
      categoryRows,
      ['description'],
      true,
      (c) =>
        prisma.categoryTranslation.update({
          where: { id: c.id },
          data: c.data,
        }),
    );
  }

  const collectionRows = await prisma.creatorCategoryTranslation.findMany({
    where: creatorId ? { creator_category: { creator_id: creatorId } } : {},
    select: { id: true, description: true },
  });
  await run(
    'CreatorCategoryTranslation.description',
    collectionRows,
    ['description'],
    true,
    (c) =>
      prisma.creatorCategoryTranslation.update({
        where: { id: c.id },
        data: c.data,
      }),
  );

  const storeRows = await prisma.store.findMany({
    where: storeId ? { id: storeId } : {},
    select: { id: true, description: true },
  });
  await run('Store.description', storeRows, ['description'], true, (c) =>
    prisma.store.update({ where: { id: c.id }, data: c.data }),
  );

  const pageRows = await prisma.staticPageTranslation.findMany({
    where: storeId ? { page: { store_id: storeId } } : {},
    select: { id: true, content: true },
  });
  await run('StaticPageTranslation.content', pageRows, ['content'], true, (c) =>
    prisma.staticPageTranslation.update({ where: { id: c.id }, data: c.data }),
  );

  if (!APPLY) console.log('Dry-run only. Re-run with --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
