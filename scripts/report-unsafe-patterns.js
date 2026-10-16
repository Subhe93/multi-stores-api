/**
 * READ-ONLY report (M4.0 ReDoS guard): lists custom fields whose stored
 * `validation_rules.pattern` would be refused today at save time
 * (`patternProblem`: unsafe | invalid | too_long). Nothing is changed: at
 * runtime these patterns already run under the server's 50 ms timeout and
 * fail closed; merchants should simplify them.
 *
 *   node scripts/report-unsafe-patterns.js          (table)
 *   node scripts/report-unsafe-patterns.js --json   (JSON)
 *
 * Uses the compiled rules from dist/ when they already have the ReDoS
 * guard, else the TypeScript source through ts-node (dev).
 */
const path = require('path');
const { Prisma, PrismaClient } = require('@prisma/client');

function loadRules() {
  const ok = (m) => m && typeof m.patternProblem === 'function';
  const candidates = [
    path.join(__dirname, '..', 'dist', 'common', 'personalization', 'rules.js'),
    path.join(
      __dirname,
      '..',
      'dist',
      'src',
      'common',
      'personalization',
      'rules.js',
    ),
  ];
  for (const c of candidates) {
    try {
      const m = require(c);
      if (ok(m)) return m;
    } catch {
      // try the next one
    }
  }
  // Dev (or a dist/ built before the ReDoS guard): the TypeScript source.
  require('ts-node').register({ transpileOnly: true });
  const m = require(
    path.join(__dirname, '..', 'src', 'common', 'personalization', 'rules.ts'),
  );
  if (!ok(m)) throw new Error('rules without patternProblem: rebuild the API');
  return m;
}

const { patternProblem, readValidationRules } = loadRules();
const prisma = new PrismaClient();

(async () => {
  try {
    const fields = await prisma.productCustomField.findMany({
      where: { NOT: { validation_rules: { equals: Prisma.DbNull } } },
      select: {
        id: true,
        name: true,
        type: true,
        validation_rules: true,
        product: {
          select: {
            id: true,
            creator: {
              select: { store: { select: { id: true, slug: true } } },
            },
          },
        },
      },
      orderBy: [{ product_id: 'asc' }, { sort_order: 'asc' }, { id: 'asc' }],
    });
    const rows = [];
    for (const f of fields) {
      const { pattern } = readValidationRules(f.validation_rules);
      if (!pattern) continue;
      const problem = patternProblem(pattern);
      if (!problem) continue;
      rows.push({
        field_id: f.id,
        field_name: f.name,
        type: f.type,
        product_id: f.product?.id ?? null,
        store: f.product?.creator?.store?.slug ?? null,
        problem,
        pattern,
      });
    }
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(
        `Scanned ${fields.length} fields with rules; ${rows.length} stored pattern(s) would be refused today.`,
      );
      if (rows.length) console.table(rows);
    }
  } catch (e) {
    console.error('ERR:', e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
