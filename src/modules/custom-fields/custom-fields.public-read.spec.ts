import { CustomFieldsService } from './custom-fields.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import {
  appFields,
  plainFields,
  plainFieldsM40,
} from '../personalization/__fixtures__/app-fields';

// M4.1 WP-C (+ M4.1 fixes): the public GET products/:id/custom-fields
// answers only for a PUBLISHED product, keeps the M4.0 bytes for products
// without M4.1 config (no app lookup), never returns the preset bookkeeping
// keys, and with the app off has the storefront D10 shape (top-level fields
// of M4.0 types, no M4.1 columns).

function build(
  fields: unknown[],
  appOn: boolean,
  status: string | null = 'PUBLISHED',
) {
  const prisma = {
    productCustomField: { findMany: jest.fn(() => Promise.resolve(fields)) },
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve(status ? { creator_id: 'c1', status } : null),
      ),
    },
    store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
  };
  const storeApps = { isEnabled: jest.fn(() => Promise.resolve(appOn)) };
  const service = new CustomFieldsService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
  );
  return { service, prisma, storeApps };
}

async function statusOf(p: Promise<unknown>): Promise<number | null> {
  try {
    await p;
  } catch (e) {
    return (e as { getStatus(): number }).getStatus();
  }
  return null;
}

describe('CustomFieldsService.findPublicByProduct (M4.1)', () => {
  it('product without M4.1 config: the M4.0 rows byte for byte, no app lookup', async () => {
    const { service, storeApps } = build(plainFields(), true);
    const rows = await service.findPublicByProduct('p1');
    expect(JSON.stringify(rows)).toBe(JSON.stringify(plainFieldsM40()));
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
  });

  it.each([['DRAFT'], ['ARCHIVED'], [null]])(
    'a product that is not published (%s) is a 404',
    async (status) => {
      const { service, prisma } = build(appFields(), true, status);
      expect(await statusOf(service.findPublicByProduct('p1'))).toBe(404);
      expect(prisma.productCustomField.findMany).not.toHaveBeenCalled();
    },
  );

  it('app on: every column except the preset bookkeeping keys', async () => {
    const { service } = build(appFields(), true);
    const rows = (await service.findPublicByProduct('p1')) as unknown as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(appFields().length);
    expect(rows[0]).toHaveProperty('conditions', null);
    expect(rows[2]).toHaveProperty('parent_id');
    for (const r of rows) {
      expect(r).not.toHaveProperty('preset_key');
      expect(r).not.toHaveProperty('preset_ref');
    }
  });

  it('app off: the storefront D10 shape (top level, M4.0 types, no M4.1 columns)', async () => {
    const { service } = build(appFields(), false);
    const rows = (await service.findPublicByProduct('p1')) as unknown as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r.type)).toEqual(['TEXT']);
    for (const key of [
      'parent_id',
      'conditions',
      'pricing',
      'repeat',
      'ui',
      'preset_key',
      'preset_ref',
    ]) {
      expect(rows[0]).not.toHaveProperty(key);
    }
  });
});
