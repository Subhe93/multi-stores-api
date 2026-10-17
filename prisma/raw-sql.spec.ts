import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * M5 F5: schema.prisma vs migrations drift guard (see prisma/RAW-SQL.md).
 * `prisma migrate diff --from-migrations … --to-schema-datamodel …` replays
 * the migrations on a shadow database and prints the SQL that would turn
 * that state into the schema. The only expected output is the removal of
 * the hand-written objects Prisma cannot model (the allowlist); any other
 * statement is a migration/schema mismatch. Skipped without
 * SHADOW_DATABASE_URL so the unit-test run never needs a database.
 */

/** Names of the hand-written objects that `migrate diff` is allowed to mention. */
export const RAW_SQL_ALLOWLIST: readonly string[] = [
  'ProductMarketPrice_market_product_novariant_key',
  'Invoice_one_invoice_per_order',
  'Invoice_sign_check',
  'Invoice_credit_ref_check',
  'invoice_guard',
  'Invoice_guard_update',
  'Invoice_guard_delete',
  'Invoice_guard_truncate',
  'StoreCustomerTaxExemption_active',
  'ImportRun_one_active_per_store',
  'OrderItemDesign_queue_claim_idx',
  'OrderItemDesign_assets_gin_idx',
];

const ROOT = join(__dirname, '..');
const SHADOW_URL = process.env.SHADOW_DATABASE_URL;

/** SQL statements of a `--script` diff, without comments and blank lines. */
export function diffStatements(script: string): string[] {
  return script
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;$/, ''),
    )
    .filter(Boolean);
}

/** Statements that mention none of the allowlisted objects (= drift). */
export function unexpectedStatements(
  script: string,
  allow: readonly string[] = RAW_SQL_ALLOWLIST,
): string[] {
  return diffStatements(script).filter(
    (s) => !allow.some((name) => s.includes(name)),
  );
}

function migrateDiff(shadowUrl: string): string {
  return execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--shadow-database-url',
      shadowUrl,
      '--script',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      shell: process.platform === 'win32',
    },
  );
}

describe('raw SQL allowlist (pure)', () => {
  it('splits a script into statements and ignores comments', () => {
    const script = [
      '-- DropIndex',
      'DROP INDEX "ImportRun_one_active_per_store";',
      '',
      '-- AlterTable',
      'ALTER TABLE "Store" ADD COLUMN "x" TEXT;',
    ].join('\n');
    expect(diffStatements(script)).toEqual([
      'DROP INDEX "ImportRun_one_active_per_store"',
      'ALTER TABLE "Store" ADD COLUMN "x" TEXT',
    ]);
    expect(unexpectedStatements(script)).toEqual([
      'ALTER TABLE "Store" ADD COLUMN "x" TEXT',
    ]);
    expect(unexpectedStatements('-- This is an empty migration.\n')).toEqual(
      [],
    );
  });
});

const describeWithShadow = SHADOW_URL ? describe : describe.skip;

describeWithShadow('prisma migrate diff (SHADOW_DATABASE_URL)', () => {
  it('migrations and schema.prisma only differ by the hand-written objects', () => {
    const script = migrateDiff(SHADOW_URL!);
    const drift = unexpectedStatements(script);
    expect(drift).toEqual([]);
  }, 300_000);
});
