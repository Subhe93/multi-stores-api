import { splitDatabasePassword } from './backup-runner';

/**
 * Gap 3 (plans/s3-storage): the database password never travels on argv.
 * pg_dump / pg_restore get it through PGPASSWORD in the child env.
 */
describe('splitDatabasePassword', () => {
  it('moves a percent-encoded password into PGPASSWORD and keeps the rest', () => {
    const out = splitDatabasePassword(
      'postgresql://app:p%40ss%3Aword@db.internal:5433/shop?sslmode=require',
    );
    expect(out.url).toBe(
      'postgresql://app@db.internal:5433/shop?sslmode=require',
    );
    expect(out.env).toEqual({ PGPASSWORD: 'p@ss:word' });
    expect(out.url).not.toContain('word');
  });

  it('leaves a URL without password and an unparsable string unchanged', () => {
    expect(splitDatabasePassword('postgresql://app@localhost/shop')).toEqual({
      url: 'postgresql://app@localhost/shop',
      env: {},
    });
    expect(splitDatabasePassword('not a url')).toEqual({
      url: 'not a url',
      env: {},
    });
  });
});
