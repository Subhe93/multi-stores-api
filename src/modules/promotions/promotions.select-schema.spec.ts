import { Prisma } from '@prisma/client';
import { floorStoreSelect } from './promotions.service';

// Regression for the M100 rollback (2026-11-13): loadFloorCart selected a
// Store field that does not exist (`primary_locale`). Jest mocks accept any
// select, so this test checks every selected field against the generated
// Prisma data model instead.
describe('floorStoreSelect matches the Store model', () => {
  const store = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Store');

  it('selects only fields that exist on Store', () => {
    expect(store).toBeDefined();
    const fields = new Set(store!.fields.map((f) => f.name));
    const unknown = Object.keys(floorStoreSelect).filter((k) => !fields.has(k));
    expect(unknown).toEqual([]);
  });
});
