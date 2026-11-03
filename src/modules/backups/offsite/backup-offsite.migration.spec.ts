import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The hand-written migration and the Prisma model agree on the offsite
 * columns of `Backup` (plans/s3-storage Phase 1).
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const COLUMNS = [
  's3_key',
  's3_files_key',
  's3_etag',
  'offsite_at',
  'offsite_error',
];

describe('20261113120000_backup_offsite', () => {
  const sql = readFileSync(
    join(
      ROOT,
      'prisma',
      'migrations',
      '20261113120000_backup_offsite',
      'migration.sql',
    ),
    'utf8',
  );
  const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  const model = /model Backup \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';

  it('adds the five nullable columns to "Backup"', () => {
    expect(sql).toMatch(/ALTER TABLE "Backup"/);
    for (const col of COLUMNS) {
      expect(sql).toMatch(
        new RegExp(`ADD COLUMN "${col}" (TEXT|TIMESTAMP\\(3\\))`),
      );
    }
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it('matches the Backup model', () => {
    expect(model).not.toBe('');
    expect(model).toMatch(/s3_key\s+String\?/);
    expect(model).toMatch(/s3_files_key\s+String\?/);
    expect(model).toMatch(/s3_etag\s+String\?/);
    expect(model).toMatch(/offsite_at\s+DateTime\?/);
    expect(model).toMatch(/offsite_error\s+String\?/);
  });
});
