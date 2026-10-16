import { readFileSync } from 'fs';
import { join } from 'path';

// Guard of the hand-written migration #6 (M4.4 §3, M4-INTEGRATION §1.6):
// additive only, new columns on existing tables nullable or defaulted, and
// the one-active-run-per-store partial index present.

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261025120000_add_importer/migration.sql',
  ),
  'utf8',
);

describe('migration 20261025120000_add_importer', () => {
  it('is additive (no DROP, no data rewrite)', () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('adds only nullable or defaulted columns to existing tables', () => {
    const existing = [
      'Product',
      'ProductTranslation',
      'ProductVariant',
      'CreatorCategory',
      'CreatorCategoryTranslation',
    ];
    for (const table of existing) {
      const block = sql.match(
        new RegExp(`ALTER TABLE "${table}" ADD COLUMN[^;]*;`),
      );
      expect(block).not.toBeNull();
      for (const col of block![0].split(/ADD COLUMN/).slice(1)) {
        if (/NOT NULL/.test(col)) expect(col).toMatch(/DEFAULT/);
      }
    }
  });

  it('creates the importer tables, StoreRedirect and the partial index', () => {
    for (const t of [
      'ImportSource',
      'ImportRun',
      'ImportRunItem',
      'ImportRunLog',
      'ImportEntity',
      'ImportMedia',
      'StoreRedirect',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${t}"`);
    }
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "StoreRedirect_store_id_from_path_key"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "Product_creator_id_external_ref_key"',
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ImportRun_one_active_per_store" ON "ImportRun"\("store_id"\)\s+WHERE "status" IN \('PLANNING', 'QUEUED', 'RUNNING', 'ROLLBACK_QUEUED', 'ROLLING_BACK'\);/,
    );
  });

  it('touches no foreign key of pre-existing tables', () => {
    const fks = [...sql.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT/g)].map(
      (m) => m[1],
    );
    expect(new Set(fks)).toEqual(
      new Set([
        'ImportSource',
        'ImportRun',
        'ImportRunItem',
        'ImportRunLog',
        'StoreRedirect',
      ]),
    );
  });
});
