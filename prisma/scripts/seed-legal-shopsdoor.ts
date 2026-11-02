/**
 * Installs the English ShopsDoor legal texts (prisma/legal/shopsdoor-en.ts)
 * into the LegalPage rows: terms, privacy, refund, shipping.
 *
 * Idempotent and admin-safe: the `en` title/content of a row is written ONLY
 * when the existing English content is empty or still the seed placeholder
 * ("This is a placeholder ..."). Anything an admin has edited is left alone.
 * Other locales are never touched. A missing row is created.
 *
 * Run with:
 *   npx ts-node prisma/scripts/seed-legal-shopsdoor.ts
 * Options:
 *   --dry-run   report what would change without writing
 *   --force     overwrite the English content even when it was edited
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SHOPSDOOR_LEGAL_EN } from '../legal/shopsdoor-en';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

type LocaleMap = Record<string, string>;

function asMap(value: unknown): LocaleMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? ({ ...(value as LocaleMap) }) : {};
}

// Content counts as "untouched" when it is empty or is the placeholder written
// by prisma/seed.ts (`<p><em>This is a placeholder for the ...</em></p>`).
function isPlaceholder(html: string | undefined): boolean {
  const text = (html ?? '').replace(/<[^>]*>/g, '').trim();
  return text.length === 0 || /^This is a placeholder/i.test(text);
}

async function main() {
  let written = 0;
  let skipped = 0;

  for (const [slug, { title, content }] of Object.entries(SHOPSDOOR_LEGAL_EN)) {
    const existing = await prisma.legalPage.findUnique({ where: { slug } });

    if (!existing) {
      console.log(`[${slug}] missing -> create (en only)`);
      if (!DRY_RUN) {
        await prisma.legalPage.create({ data: { slug, title: { en: title }, content: { en: content } } });
      }
      written++;
      continue;
    }

    const titles = asMap(existing.title);
    const contents = asMap(existing.content);

    if (!FORCE && !isPlaceholder(contents.en)) {
      console.log(`[${slug}] en content already edited -> skip`);
      skipped++;
      continue;
    }

    console.log(`[${slug}] en content ${contents.en ? 'is placeholder' : 'is empty'} -> write`);
    if (!DRY_RUN) {
      await prisma.legalPage.update({
        where: { slug },
        data: {
          // The seeded title goes with the placeholder, so it is refreshed too.
          title: { ...titles, en: title },
          content: { ...contents, en: content },
        },
      });
    }
    written++;
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Legal pages: ${written} written, ${skipped} skipped`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
