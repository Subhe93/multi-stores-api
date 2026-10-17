import { resolveRedirectChain, rowsPointingAt } from './redirect-chain';
import {
  ExistingRedirectRow,
  planRedirectDeactivations,
  planRedirectUpserts,
  withoutDeactivated,
} from './redirect-plan';

// M4.4 §6.1: chains are flattened when written (A→B + B→C ⇒ A→C), loops
// are rejected, MANUAL rows are never overwritten, re-runs are idempotent.

const row = (
  id: string,
  from: string,
  to: string,
  over: Partial<ExistingRedirectRow> = {},
): ExistingRedirectRow => ({
  id,
  from_path: from,
  to_path: to,
  status_code: 301,
  source: 'IMPORT',
  is_active: true,
  ...over,
});

describe('resolveRedirectChain', () => {
  it('returns the target when nothing chains', () => {
    expect(resolveRedirectChain(new Map(), '/a', '/b')).toEqual({
      ok: true,
      to: '/b',
    });
  });

  it('flattens A→B→C→D to A→D', () => {
    const map = new Map([
      ['/b', '/c'],
      ['/c', '/d'],
    ]);
    expect(resolveRedirectChain(map, '/a', '/B/')).toEqual({
      ok: true,
      to: '/d',
    });
  });

  it('detects a self loop and a longer loop', () => {
    expect(resolveRedirectChain(new Map(), '/a', '/A/')).toEqual({
      ok: false,
      code: 'REDIRECT_LOOP',
    });
    const map = new Map([
      ['/b', '/c'],
      ['/c', '/a'],
    ]);
    expect(resolveRedirectChain(map, '/a', '/b').ok).toBe(false);
  });

  it('stops at a target with a query string but still checks loops', () => {
    const map = new Map([['/b', '/c']]);
    expect(resolveRedirectChain(map, '/a', '/b?x=1')).toEqual({
      ok: true,
      to: '/b?x=1',
    });
    expect(resolveRedirectChain(new Map(), '/a', '/a?x=1').ok).toBe(false);
  });

  it('gives up after the hop limit', () => {
    const map = new Map<string, string>();
    for (let i = 0; i < 30; i++) map.set(`/p${i}`, `/p${i + 1}`);
    // M5 B22: past the hop limit without returning to the source is not a
    // loop but a chain too long (its own code).
    expect(resolveRedirectChain(map, '/start', '/p0', 20)).toEqual({
      ok: false,
      code: 'REDIRECT_CHAIN_TOO_LONG',
    });
    expect(resolveRedirectChain(map, '/start', '/p0', 40)).toEqual({
      ok: true,
      to: '/p30',
    });
  });

  it('planRedirectUpserts reports REDIRECT_CHAIN_TOO_LONG through existing rows', () => {
    const existing: ExistingRedirectRow[] = [];
    for (let i = 0; i < 25; i++)
      existing.push(row(`r${i}`, `/p${i}`, `/p${i + 1}`));
    const plan = planRedirectUpserts(existing, [
      { from_path: '/start', to_path: '/p0' },
    ]);
    expect(plan.conflicts).toEqual([
      { from_path: '/start', to_path: '/p0', code: 'REDIRECT_CHAIN_TOO_LONG' },
    ]);
    expect(plan.items.some((i) => i.from_path === '/start')).toBe(false);
  });

  it('rowsPointingAt lists the rows to re-point', () => {
    const map = new Map([
      ['/x', '/a'],
      ['/y', '/A/'],
      ['/z', '/a?q=1'],
      ['/w', '/other'],
    ]);
    expect(rowsPointingAt(map, '/a', '/final').sort()).toEqual(['/x', '/y']);
  });
});

describe('planRedirectUpserts', () => {
  it('creates new rows with normalised from_path and default 301', () => {
    const plan = planRedirectUpserts(
      [],
      [{ from_path: '/Produkt/Namnskylt/', to_path: '/products/namnskylt' }],
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.items).toEqual([
      {
        action: 'CREATE',
        id: null,
        from_path: '/produkt/namnskylt',
        to_path: '/products/namnskylt',
        status_code: 301,
      },
    ]);
  });

  it('is idempotent: the same batch again is UNCHANGED', () => {
    const plan = planRedirectUpserts(
      [row('r1', '/produkt/a', '/products/a')],
      [{ from_path: '/produkt/a', to_path: '/products/a' }],
    );
    expect(plan.items.map((i) => [i.action, i.id])).toEqual([
      ['UNCHANGED', 'r1'],
    ]);
  });

  it('updates an IMPORT row whose target changed, or that was inactive', () => {
    const plan = planRedirectUpserts(
      [
        row('r1', '/produkt/a', '/products/a'),
        row('r2', '/produkt/b', '/products/b', { is_active: false }),
      ],
      [
        { from_path: '/produkt/a', to_path: '/products/a-2' },
        { from_path: '/produkt/b', to_path: '/products/b' },
      ],
    );
    expect(plan.items.map((i) => [i.action, i.id, i.to_path])).toEqual([
      ['UPDATE', 'r1', '/products/a-2'],
      ['UPDATE', 'r2', '/products/b'],
    ]);
  });

  it('never overwrites a MANUAL row (REDIRECT_CONFLICT)', () => {
    const plan = planRedirectUpserts(
      [row('m1', '/produkt/a', '/somewhere', { source: 'MANUAL' })],
      [{ from_path: '/produkt/a', to_path: '/products/a' }],
    );
    expect(plan.items).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        from_path: '/produkt/a',
        to_path: '/products/a',
        code: 'REDIRECT_CONFLICT',
      },
    ]);
  });

  it('rejects invalid paths and duplicate sources within the batch', () => {
    const plan = planRedirectUpserts(
      [],
      [
        { from_path: 'produkt/a', to_path: '/x' },
        { from_path: '/a', to_path: '//evil.example' },
        { from_path: '/a', to_path: '/x', status_code: 200 },
        { from_path: '/b', to_path: '/x' },
        { from_path: '/B/', to_path: '/y' },
      ],
    );
    expect(plan.conflicts.map((c) => c.code)).toEqual([
      'REDIRECT_INVALID_PATH',
      'REDIRECT_INVALID_PATH',
      'REDIRECT_INVALID_PATH',
      'REDIRECT_DUPLICATE',
    ]);
    expect(plan.items.map((i) => i.from_path)).toEqual(['/b']);
  });

  it('flattens chains inside the batch and through existing rows', () => {
    const plan = planRedirectUpserts(
      [row('m1', '/old-home', '/collections/new', { source: 'MANUAL' })],
      [
        { from_path: '/a', to_path: '/b' },
        { from_path: '/b', to_path: '/old-home' },
      ],
    );
    expect(plan.items.map((i) => [i.from_path, i.to_path])).toEqual([
      ['/a', '/collections/new'],
      ['/b', '/collections/new'],
    ]);
  });

  it('drops the row that closes a loop and keeps the rest', () => {
    const plan = planRedirectUpserts(
      [],
      [
        { from_path: '/a', to_path: '/b' },
        { from_path: '/b', to_path: '/a' },
      ],
    );
    expect(plan.conflicts).toEqual([
      { from_path: '/a', to_path: '/b', code: 'REDIRECT_LOOP' },
    ]);
    expect(plan.items.map((i) => [i.from_path, i.to_path])).toEqual([
      ['/b', '/a'],
    ]);
  });

  it('re-points existing IMPORT rows whose target became a source', () => {
    const plan = planRedirectUpserts(
      [
        row('r1', '/x', '/products/a'),
        row('m1', '/y', '/products/a', { source: 'MANUAL' }),
      ],
      [{ from_path: '/products/a', to_path: '/products/a-2' }],
    );
    expect(plan.repoints).toEqual([
      { id: 'r1', from_path: '/x', to_path: '/products/a-2' },
    ]);
  });
});

describe('planRedirectDeactivations (live path shadowing)', () => {
  const rows = [
    row('1', '/products/a', '/products/b'),
    row('2', '/products/m', '/x', { source: 'MANUAL' }),
    row('3', '/products/c', '/y', { is_active: false }),
    row('4', '/produkt/a', '/products/b'),
  ];
  const live = new Set(['/products/a', '/products/m', '/products/c']);

  it('switches off active IMPORT rows whose from_path is live; MANUAL and inactive rows stay', () => {
    expect(planRedirectDeactivations(rows, live)).toEqual([
      {
        id: '1',
        from_path: '/products/a',
        to_path: '/products/b',
        status_code: 301,
      },
    ]);
    expect(planRedirectDeactivations(rows, new Set())).toEqual([]);
  });

  it('a reverted rename (a→b, then b→a) is no loop once the old row is off', () => {
    const incoming = [{ from_path: '/products/b', to_path: '/products/a' }];
    // Without the deactivation the reverse redirect loops through row 1.
    expect(planRedirectUpserts(rows, incoming).conflicts).toEqual([
      {
        from_path: '/products/b',
        to_path: '/products/a',
        code: 'REDIRECT_LOOP',
      },
    ]);
    const off = planRedirectDeactivations(rows, live);
    const plan = planRedirectUpserts(withoutDeactivated(rows, off), incoming);
    expect(plan.conflicts).toEqual([]);
    expect(plan.items).toEqual([
      {
        action: 'CREATE',
        id: null,
        from_path: '/products/b',
        to_path: '/products/a',
        status_code: 301,
      },
    ]);
    // Row 4 pointed at /products/b, a source now: re-pointed to the live page.
    expect(plan.repoints).toEqual([
      { id: '4', from_path: '/produkt/a', to_path: '/products/a' },
    ]);
  });
});
