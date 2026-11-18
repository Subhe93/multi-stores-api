import { effectiveCodEnabled, withEffectiveCod } from './cod-policy';
import { ownerStorePayload, publicStoreRow } from './store-secrets';

describe('effectiveCodEnabled', () => {
  it('is true only for an INDEPENDENT store with the flag on', () => {
    expect(
      effectiveCodEnabled({ store_type: 'INDEPENDENT', cod_enabled: true }),
    ).toBe(true);
    expect(
      effectiveCodEnabled({ store_type: 'INDEPENDENT', cod_enabled: false }),
    ).toBe(false);
    expect(
      effectiveCodEnabled({ store_type: 'MARKETPLACE', cod_enabled: true }),
    ).toBe(false);
    expect(
      effectiveCodEnabled({ store_type: 'MARKETPLACE', cod_enabled: false }),
    ).toBe(false);
  });

  it('is false for missing or malformed input', () => {
    expect(effectiveCodEnabled(null)).toBe(false);
    expect(effectiveCodEnabled(undefined)).toBe(false);
    expect(effectiveCodEnabled({})).toBe(false);
    expect(effectiveCodEnabled({ cod_enabled: true })).toBe(false);
    expect(
      effectiveCodEnabled({ store_type: 'INDEPENDENT', cod_enabled: null }),
    ).toBe(false);
  });
});

describe('withEffectiveCod', () => {
  it('rewrites the flag of a marketplace row and keeps the rest', () => {
    expect(
      withEffectiveCod({
        id: 's1',
        store_type: 'MARKETPLACE',
        cod_enabled: true,
      }),
    ).toEqual({ id: 's1', store_type: 'MARKETPLACE', cod_enabled: false });
  });

  it('leaves an independent row as stored', () => {
    const row = { id: 's1', store_type: 'INDEPENDENT', cod_enabled: true };
    expect(withEffectiveCod(row)).toEqual(row);
  });

  it('does not touch a row without both columns', () => {
    const partial = { id: 's1', cod_enabled: true };
    expect(withEffectiveCod(partial)).toBe(partial);
    const none = { id: 's1' };
    expect(withEffectiveCod(none)).toBe(none);
  });
});

describe('store payload helpers carry the effective COD flag', () => {
  it('owner payload', () => {
    expect(
      ownerStorePayload({
        id: 's1',
        store_type: 'MARKETPLACE',
        cod_enabled: true,
        meta_capi_token: null,
      }),
    ).toEqual({
      id: 's1',
      store_type: 'MARKETPLACE',
      cod_enabled: false,
      meta_capi_token_set: false,
    });
    expect(
      ownerStorePayload({
        id: 's1',
        store_type: 'INDEPENDENT',
        cod_enabled: true,
      }).cod_enabled,
    ).toBe(true);
  });

  it('public row', () => {
    expect(
      publicStoreRow({
        id: 's1',
        store_type: 'MARKETPLACE',
        cod_enabled: true,
      }),
    ).toEqual({ id: 's1', store_type: 'MARKETPLACE', cod_enabled: false });
    expect(
      publicStoreRow({
        id: 's1',
        store_type: 'INDEPENDENT',
        cod_enabled: true,
      }).cod_enabled,
    ).toBe(true);
  });
});
