import { chromiumChannel, chromiumExecutablePath } from './chromium-env';
import { stripPrismaParams } from './pg-listener';
import { productionEnvViolations } from './startup-guards';
import { applyWorkersEnv, workerFlags } from './workers-env';

describe('applyWorkersEnv (WORKERS single switch)', () => {
  it('does nothing when WORKERS is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyWorkersEnv(env).applied).toBe(false);
    expect(env).toEqual({});
  });

  it('turns listed workers on and the others off', () => {
    const env: NodeJS.ProcessEnv = { WORKERS: 'retention, Designer' };
    const r = applyWorkersEnv(env);
    expect(r.applied).toBe(true);
    expect(env.RETENTION_SCHEDULER).toBe('on');
    expect(env.DESIGNER_RENDER_QUEUE).toBe('on');
    expect(env.BACKUP_SCHEDULER).toBe('off');
    expect(env.IMPORTER_WORKER).toBe('off');
    expect(workerFlags(env)).toEqual({
      retention: true,
      backup: false,
      importer: false,
      designer: true,
    });
  });

  it('empty or "none" switches all four off; unknown names are reported', () => {
    const env: NodeJS.ProcessEnv = { WORKERS: 'none,mailer' };
    const r = applyWorkersEnv(env);
    expect(r.unknown).toEqual(['mailer']);
    expect(workerFlags(env)).toEqual({
      retention: false,
      backup: false,
      importer: false,
      designer: false,
    });
    const empty: NodeJS.ProcessEnv = { WORKERS: '' };
    applyWorkersEnv(empty);
    expect(empty.BACKUP_SCHEDULER).toBe('off');
  });

  it('legacy per-worker flags win (DESIGNER_WORKER alias included)', () => {
    const env: NodeJS.ProcessEnv = {
      WORKERS: 'backup',
      BACKUP_SCHEDULER: 'off',
      DESIGNER_WORKER: 'on',
    };
    const r = applyWorkersEnv(env);
    expect(env.BACKUP_SCHEDULER).toBe('off');
    expect(env.DESIGNER_RENDER_QUEUE).toBeUndefined();
    expect(r.set).toEqual({
      RETENTION_SCHEDULER: 'off',
      IMPORTER_WORKER: 'off',
    });
  });
});

describe('chromium env aliases', () => {
  it('legacy names win, CHROMIUM_* is the fallback, blanks are skipped', () => {
    const env: NodeJS.ProcessEnv = {
      CHROMIUM_PATH: '/usr/bin/chromium',
      CHROMIUM_CHANNEL: 'chrome',
      INVOICE_PDF_CHROMIUM_PATH: '  ',
      DESIGNER_BROWSER_CHANNEL: 'msedge',
    };
    expect(chromiumExecutablePath(env, 'INVOICE_PDF_CHROMIUM_PATH')).toBe(
      '/usr/bin/chromium',
    );
    expect(
      chromiumExecutablePath(
        env,
        'DESIGNER_CHROMIUM_PATH',
        'INVOICE_PDF_CHROMIUM_PATH',
      ),
    ).toBe('/usr/bin/chromium');
    expect(chromiumChannel(env, 'INVOICE_PDF_BROWSER_CHANNEL')).toBe('chrome');
    expect(
      chromiumChannel(
        env,
        'DESIGNER_BROWSER_CHANNEL',
        'INVOICE_PDF_BROWSER_CHANNEL',
      ),
    ).toBe('msedge');
  });

  it('only legacy names set: unchanged behaviour', () => {
    const env: NodeJS.ProcessEnv = { DESIGNER_CHROMIUM_PATH: '/opt/c' };
    expect(
      chromiumExecutablePath(
        env,
        'DESIGNER_CHROMIUM_PATH',
        'INVOICE_PDF_CHROMIUM_PATH',
      ),
    ).toBe('/opt/c');
    expect(
      chromiumExecutablePath(env, 'INVOICE_PDF_CHROMIUM_PATH'),
    ).toBeUndefined();
    expect(chromiumChannel(env, 'INVOICE_PDF_BROWSER_CHANNEL')).toBeUndefined();
  });
});

describe('productionEnvViolations', () => {
  it('reports dev-only switches only in production', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      IMPORTER_ALLOW_PRIVATE_HOSTS: '1',
      DESIGNER_RENDER_REAL: '1',
      DESIGNER_RENDER_DUMP: '',
    };
    const v = productionEnvViolations(env);
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('IMPORTER_ALLOW_PRIVATE_HOSTS');
    expect(v[1]).toContain('DESIGNER_RENDER_REAL');
    expect(
      productionEnvViolations({ ...env, NODE_ENV: 'development' }),
    ).toEqual([]);
  });
});

describe('stripPrismaParams', () => {
  it('drops only the schema parameter', () => {
    expect(stripPrismaParams('postgresql://u:p@h/db?schema=public')).toBe(
      'postgresql://u:p@h/db',
    );
    expect(
      stripPrismaParams('postgresql://u:p@h/db?sslmode=require&schema=public'),
    ).toBe('postgresql://u:p@h/db?sslmode=require');
    expect(stripPrismaParams('postgresql://u:p@h/db')).toBe(
      'postgresql://u:p@h/db',
    );
  });
});
