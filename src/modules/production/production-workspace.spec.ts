import type { OrderProductionCheck } from '@prisma/client';
import {
  buildWorkspace,
  toCheckView,
  type WorkspaceOrderSource,
} from './production-workspace';
import { DEFAULT_PRODUCTION_SETTINGS } from './production-settings';

// Shaping of GET production/my/orders/:orderId: the quantity of the line
// travels with every check (one check per line, design Q14) so the sheet
// can print "×qty", and the variant label prefers the order-time snapshot.

const check = (
  over: Partial<OrderProductionCheck> = {},
): OrderProductionCheck =>
  ({
    id: 'c1',
    store_id: 's1',
    order_id: 'o1',
    order_item_id: 'i1',
    source: 'VARIANT_OPTION',
    source_key: 'opt:Färg',
    source_hash: null,
    label: 'Färg',
    value: 'Röd',
    group_index: null,
    file_url: null,
    sort_order: 0,
    done: false,
    done_at: null,
    done_by: null,
    done_by_name: null,
    stale: false,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  }) as OrderProductionCheck;

const order: WorkspaceOrderSource = {
  id: 'o1',
  order_number: '1001',
  status: 'MANUFACTURING',
  created_at: new Date(),
  items: [
    {
      id: 'i1',
      quantity: 3,
      fulfiller_type: 'CREATOR',
      fulfiller_id: 'cr1',
      fulfillment_status: 'PROCESSING',
      variant_options_snapshot: { Färg: 'Röd' },
      // Edited after the order: must not show.
      variant: { options: { Färg: 'Blå' } },
    },
    {
      id: 'i2',
      quantity: 1,
      fulfiller_type: 'CREATOR',
      fulfiller_id: 'cr1',
      fulfillment_status: 'PROCESSING',
      variant_options_snapshot: null,
      variant: { options: { Size: 'L' } },
    },
  ],
};

describe('production workspace view (M4.3 §3.7)', () => {
  it('every check carries the quantity of its line; write responses carry null', () => {
    const ws = buildWorkspace({
      order,
      checks: [check(), check({ id: 'c2', order_item_id: 'i2' })],
      summary: { total: 2, done: 0, state: 'NOT_STARTED', completed_at: null },
      suggestion: null,
      settings: DEFAULT_PRODUCTION_SETTINGS,
      creatorId: 'cr1',
      primaryLocale: 'sv',
      printFiles: [],
    });
    expect(ws.lines.map((l) => [l.quantity, l.checks[0].quantity])).toEqual([
      [3, 3],
      [1, 1],
    ]);
    expect(toCheckView(check()).quantity).toBeNull();
  });

  it('the variant label comes from the snapshot, falling back to the live variant for older lines', () => {
    const ws = buildWorkspace({
      order,
      checks: [],
      summary: { total: 0, done: 0, state: 'NONE', completed_at: null },
      suggestion: null,
      settings: DEFAULT_PRODUCTION_SETTINGS,
      creatorId: 'cr1',
      primaryLocale: 'sv',
      printFiles: [],
    });
    expect(ws.lines.map((l) => l.variant_label)).toEqual([
      'Färg: Röd',
      'Size: L',
    ]);
  });

  it('value checks carry the swatch colour and the group label of their order row', () => {
    const withValues: WorkspaceOrderSource = {
      ...order,
      items: [
        {
          ...order.items[0],
          custom_field_values: [
            {
              id: 'v1',
              group_index: 2,
              group_label: { sv: 'Artikel 2', en: 'Item 2' },
              meta: { hex: '#F4A6C0', option_name: 'Färg' },
            },
            { id: 'v2', group_index: 2, group_label: null, meta: null },
            { id: 'v3', group_index: null, meta: { hex: 'red' } },
          ],
        },
      ],
    };
    const ws = buildWorkspace({
      order: withValues,
      checks: [
        check({
          id: 'c1',
          source: 'FIELD_VALUE',
          source_key: 'fv:v1',
          group_index: 2,
          label: 'Artikel 2 – Färg',
          value: 'Rosa',
        }),
        check({
          id: 'c2',
          source: 'FIELD_VALUE',
          source_key: 'fv:v2',
          group_index: 2,
          label: '#2 – Namn',
          value: 'Alicia',
        }),
        check({
          id: 'c3',
          source: 'FIELD_VALUE',
          source_key: 'fv:v3',
          label: 'Ton',
          value: 'red',
        }),
        check({ id: 'c4' }),
      ],
      summary: { total: 4, done: 0, state: 'NOT_STARTED', completed_at: null },
      suggestion: null,
      settings: DEFAULT_PRODUCTION_SETTINGS,
      creatorId: 'cr1',
      primaryLocale: 'sv',
      printFiles: [],
    });
    expect(ws.lines[0].checks.map((c) => [c.id, c.hex, c.group_label])).toEqual(
      [
        ['c1', '#F4A6C0', 'Artikel 2'],
        ['c2', null, '#2'],
        // Not a valid hex colour, not grouped.
        ['c3', null, null],
        // Variant option check: no value row.
        ['c4', null, null],
      ],
    );
    // Write responses carry neither (the client keeps what it holds).
    expect(toCheckView(check())).toMatchObject({
      hex: null,
      group_label: null,
    });
  });
});
