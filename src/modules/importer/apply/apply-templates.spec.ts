import { applyTemplates } from './apply-templates';
import type { ApplyContext } from './apply-context';
import type { PlannedTemplate } from '../planner/planner';
import type { DesignerUpsertOptions } from '../../../common/ports/designer-import.port';

// M4.2 fixes: the designer port returns partial results; the importer
// ledgers the templates that succeeded and records the failed ones as ERROR
// (no ledger row, so the next run retries them).

jest.mock('./apply-context', () => ({
  appliedRefs: jest.fn(() => Promise.resolve(new Set<string>())),
  upsertLedger: jest.fn(() => Promise.resolve()),
  recordItems: jest.fn(() => Promise.resolve()),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const applyContext = require('./apply-context') as {
  upsertLedger: jest.Mock;
  recordItems: jest.Mock;
};

const planned = (id: string): PlannedTemplate =>
  ({
    action: 'CREATE',
    source_hash: `h-${id}`,
    target_id: null,
    template: {
      ext_id: `woo:namez.se:npp_template:${id}`,
      assets: [],
      thumbnail: null,
    },
  }) as unknown as PlannedTemplate;

describe('applyTemplates partial results', () => {
  it('ledgers the successes, records the failure as ERROR', async () => {
    const ok = 'woo:namez.se:npp_template:1';
    const bad = 'woo:namez.se:npp_template:2';
    const designer = {
      upsertTemplates: jest.fn(
        async (
          _s: string,
          _t: unknown,
          _m: unknown,
          opts: DesignerUpsertOptions,
        ) => {
          await opts.onResult?.({
            ext_id: ok,
            template_id: 't1',
            action: 'CREATE',
            pending_assets: [],
            warnings: [],
          });
          await opts.onResult?.({
            ext_id: bad,
            template_id: null,
            action: 'ERROR',
            pending_assets: [],
            warnings: [],
            error: 'disk full',
          });
          return new Map([[ok, 't1']]);
        },
      ),
      linkProduct: jest.fn(),
    };
    const log = jest.fn(() => Promise.resolve());
    const prisma = {
      product: { findMany: jest.fn(() => Promise.resolve([])) },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    };
    const ctx = {
      prisma,
      storeId: 's1',
      creatorId: 'c1',
      runId: 'r1',
      siteHost: 'namez.se',
      options: { scopes: { media: true } },
      designer,
      media: new Map(),
      log,
      checkpoint: jest.fn(() => Promise.resolve()),
    } as unknown as ApplyContext;

    await applyTemplates(ctx, [planned('1'), planned('2')], []);

    expect(applyContext.upsertLedger).toHaveBeenCalledTimes(1);
    expect(applyContext.upsertLedger).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ external_ref: ok, target_id: 't1' }),
    );
    expect(log).toHaveBeenCalledWith(
      'ERROR',
      'IMPORT_TEMPLATE_FAILED',
      'disk full',
      expect.objectContaining({ external_ref: bad }),
    );
    const call = applyContext.recordItems.mock.calls[0] as unknown[];
    const items = call[3] as {
      external_ref: string;
      action: string;
    }[];
    expect(items).toEqual([
      expect.objectContaining({ external_ref: ok, action: 'CREATE' }),
      expect.objectContaining({
        external_ref: bad,
        action: 'ERROR',
        message: 'disk full',
      }),
    ]);
  });
});
