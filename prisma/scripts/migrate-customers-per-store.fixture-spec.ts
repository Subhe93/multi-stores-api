/**
 * Test fixture shared by the planner unit spec and the local-DB spec of
 * migrate-customers-per-store. It reproduces the production shapes of
 * 2026-11-01 (plans/customer-per-store/PLAN.md, "Prod data"):
 *   - 10 customers that ordered from one store
 *   - 2 multi-store customers: naturalcotton 1 + namez-se 3, namez 5 + namez-se 1,
 *     each with an address used by orders of both stores
 *   - 1 customer whose orders all have store_id NULL (store from the items)
 *   - 4 zero-order customers, one with a cart item (namez-se product)
 * Not a spec itself (no ".spec.ts" suffix); excluded from the build by the
 * "*spec.ts" pattern of tsconfig.build.json.
 */

export const STORES = ['naturalcotton', 'namez-se', 'namez', 'demo'] as const;
export type StoreSlug = (typeof STORES)[number];

export interface FxOrder {
  /** null = legacy order without store_id. */
  store: StoreSlug | null;
  /** Store whose creator owns the product of the single order item. */
  itemStore: StoreSlug;
  address: string;
  /** Days after 2026-01-01. */
  day: number;
  notify?: boolean;
  promo?: boolean;
  invoice?: boolean;
  kustom?: boolean;
}

export interface FxCustomer {
  key: string;
  email: string;
  /** Days after 2025-06-01. */
  createdDay: number;
  addresses: string[];
  orders: FxOrder[];
  cart?: StoreSlug;
  kustom?: StoreSlug[];
  designs?: StoreSlug[];
  tax?: StoreSlug[];
  resetSession?: boolean;
  markerSession?: boolean;
  loginToken?: StoreSlug;
}

const single = (
  key: string,
  store: StoreSlug,
  day: number,
  extra: Partial<FxCustomer> = {},
): FxCustomer => ({
  key,
  email: `${key}@example.test`,
  createdDay: day,
  addresses: [`${key}-a`],
  orders: [{ store, itemStore: store, address: `${key}-a`, day }],
  ...extra,
});

export const CUSTOMERS: FxCustomer[] = [
  single('s1', 'naturalcotton', 1),
  single('s2', 'naturalcotton', 2),
  single('s3', 'naturalcotton', 3, {
    orders: [
      {
        store: 'naturalcotton',
        itemStore: 'naturalcotton',
        address: 's3-a',
        day: 3,
      },
      {
        store: 'naturalcotton',
        itemStore: 'naturalcotton',
        address: 's3-a',
        day: 30,
        notify: true,
      },
    ],
  }),
  single('s4', 'naturalcotton', 4),
  single('s5', 'namez-se', 5, { kustom: ['namez-se'], resetSession: true }),
  single('s6', 'namez-se', 6),
  single('s7', 'namez-se', 7),
  single('s8', 'namez', 8),
  single('s9', 'namez', 9, { markerSession: true }),
  single('s10', 'demo', 10),
  {
    // f5c120e4…: naturalcotton 1 order, namez-se 3 orders.
    key: 'multiA',
    email: 'multia@example.test',
    createdDay: 11,
    addresses: ['mA-1', 'mA-2'],
    orders: [
      {
        store: 'naturalcotton',
        itemStore: 'naturalcotton',
        address: 'mA-1',
        day: 12,
        notify: true,
      },
      { store: 'namez-se', itemStore: 'namez-se', address: 'mA-1', day: 40 },
      { store: 'namez-se', itemStore: 'namez-se', address: 'mA-1', day: 41 },
      {
        store: 'namez-se',
        itemStore: 'namez-se',
        address: 'mA-2',
        day: 42,
        notify: true,
      },
    ],
  },
  {
    // d5c930a7…: namez (old) 5 orders, namez-se 1 order.
    key: 'multiB',
    email: 'multib@example.test',
    createdDay: 13,
    addresses: ['mB-1', 'mB-2'],
    orders: [
      { store: 'namez', itemStore: 'namez', address: 'mB-1', day: 14 },
      { store: 'namez', itemStore: 'namez', address: 'mB-1', day: 15 },
      { store: 'namez', itemStore: 'namez', address: 'mB-2', day: 16 },
      { store: 'namez', itemStore: 'namez', address: 'mB-1', day: 17 },
      {
        store: 'namez',
        itemStore: 'namez',
        address: 'mB-1',
        day: 18,
        promo: true,
      },
      {
        store: 'namez-se',
        itemStore: 'namez-se',
        address: 'mB-1',
        day: 50,
        notify: true,
        promo: true,
        invoice: true,
        kustom: true,
      },
    ],
    designs: ['namez-se'],
    tax: ['namez-se'],
    resetSession: true,
    markerSession: true,
    loginToken: 'namez-se',
  },
  {
    key: 'nullOnly',
    email: 'nullonly@example.test',
    createdDay: 14,
    addresses: ['n-a'],
    orders: [
      { store: null, itemStore: 'naturalcotton', address: 'n-a', day: 2 },
      { store: null, itemStore: 'naturalcotton', address: 'n-a', day: 5 },
    ],
  },
  // Zero-order customers.
  {
    key: 'z1',
    email: 'cu1@test.com',
    createdDay: 20,
    addresses: [],
    orders: [],
  },
  {
    key: 'z2',
    email: 'su2@gmail.com',
    createdDay: 21,
    addresses: ['z2-a'],
    orders: [],
  },
  {
    key: 'z3',
    email: 'hu3@mailinator.com',
    createdDay: 22,
    addresses: [],
    orders: [],
    cart: 'namez-se',
  },
  {
    key: 'z4',
    email: 'sa4@gmail.com',
    createdDay: 23,
    addresses: [],
    orders: [],
  },
];

export const dayOf = (base: string, day: number): Date =>
  new Date(new Date(base).getTime() + day * 86_400_000);
export const orderDate = (day: number) => dayOf('2026-01-01T10:00:00Z', day);
export const createdDate = (day: number) => dayOf('2025-06-01T10:00:00Z', day);
