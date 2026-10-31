import type { ExistingRedirectRow } from './redirect-plan';
import { planSlugChangeRedirects } from './slug-redirects';

// Old-slug 301s (WP `_wp_old_slug`): planner over the store's current rows.

const row = (
  id: string,
  from_path: string,
  to_path: string,
  source: ExistingRedirectRow['source'] = 'SLUG_CHANGE',
  is_active = true,
): ExistingRedirectRow => ({
  id,
  from_path,
  to_path,
  status_code: 301,
  source,
  is_active,
});

describe('planSlugChangeRedirects', () => {
  it('creates old -> new with a normalised from_path', () => {
    const plan = planSlugChangeRedirects(
      [],
      [{ from: '/products/KL%C3%A4der', to: '/products/klader' }],
    );
    expect(plan.creates).toEqual([
      { from_path: '/products/kläder', to_path: '/products/klader' },
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it('re-points rows that targeted the old path (one hop, MANUAL included)', () => {
    const plan = planSlugChangeRedirects(
      [
        row('r1', '/produkt/mugg', '/products/mugg', 'IMPORT'),
        row('r2', '/gammal', '/products/mugg', 'MANUAL'),
      ],
      [{ from: '/products/mugg', to: '/products/kaffemugg' }],
    );
    expect(plan.creates).toEqual([
      { from_path: '/products/mugg', to_path: '/products/kaffemugg' },
    ]);
    expect(plan.repoints).toEqual([
      { id: 'r1', from_path: '/produkt/mugg', to_path: '/products/kaffemugg' },
      { id: 'r2', from_path: '/gammal', to_path: '/products/kaffemugg' },
    ]);
  });

  it('a rename back (a -> b, then b -> a) switches off the shadowing row: no loop', () => {
    const plan = planSlugChangeRedirects(
      [row('r1', '/products/a', '/products/b')],
      [{ from: '/products/b', to: '/products/a' }],
    );
    expect(plan.deactivations).toEqual([
      { id: 'r1', from_path: '/products/a' },
    ]);
    expect(plan.creates).toEqual([
      { from_path: '/products/b', to_path: '/products/a' },
    ]);
    // r1 is off, so it is not re-pointed into a self-loop.
    expect(plan.repoints).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('respects the merchant: a MANUAL row on the old path is left and reported', () => {
    const plan = planSlugChangeRedirects(
      [row('m1', '/products/mugg', '/sale', 'MANUAL')],
      [{ from: '/products/mugg', to: '/products/kaffemugg' }],
    );
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        from_path: '/products/mugg',
        to_path: '/products/kaffemugg',
        code: 'REDIRECT_CONFLICT',
      },
    ]);
  });

  it('a MANUAL row on the new path is reported, not switched off', () => {
    const plan = planSlugChangeRedirects(
      [row('m1', '/products/kaffemugg', '/sale', 'MANUAL')],
      [{ from: '/products/mugg', to: '/products/kaffemugg' }],
    );
    expect(plan.deactivations).toEqual([]);
    expect(plan.conflicts.map((c) => c.code)).toContain(
      'REDIRECT_SHADOWS_TARGET',
    );
  });

  it('rewrites an existing IMPORT row of the old path instead of duplicating it', () => {
    const plan = planSlugChangeRedirects(
      [row('i1', '/products/mugg', '/products/x', 'IMPORT', false)],
      [{ from: '/products/mugg', to: '/products/kaffemugg' }],
    );
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([
      { id: 'i1', from_path: '/products/mugg', to_path: '/products/kaffemugg' },
    ]);
  });

  it('a collection subtree moves in one batch; same-path moves are skipped', () => {
    const plan = planSlugChangeRedirects(
      [],
      [
        { from: '/collections/klader', to: '/collections/mode' },
        { from: '/collections/klader/troja', to: '/collections/mode/troja' },
        { from: '/collections/skor', to: '/collections/SKOR' },
      ],
    );
    expect(plan.creates.map((c) => c.from_path)).toEqual([
      '/collections/klader',
      '/collections/klader/troja',
    ]);
  });

  it('flattens chains: old -> new where new already redirects', () => {
    const plan = planSlugChangeRedirects(
      [row('r1', '/b', '/c', 'MANUAL')],
      [{ from: '/a', to: '/b' }],
    );
    // `/b` is the new live path, but a MANUAL row on it is the merchant's
    // choice: the new row follows it to its final target.
    expect(plan.creates).toEqual([{ from_path: '/a', to_path: '/c' }]);
  });

  it('invalid paths are reported', () => {
    const plan = planSlugChangeRedirects([], [{ from: 'x', to: '/y' }]);
    expect(plan.conflicts[0].code).toBe('REDIRECT_INVALID_PATH');
  });
});
