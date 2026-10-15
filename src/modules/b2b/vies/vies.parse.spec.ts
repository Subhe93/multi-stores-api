import {
  isEuVatPrefix,
  parseViesResponse,
  splitViesNumber,
  toViesCountry,
  viesCountryToIso,
} from './vies.parse';

// Literal payloads as returned by the VIES REST API (probed 2026-10-15).

describe('parseViesResponse', () => {
  it('valid with a requester keeps the consultation number', () => {
    expect(
      parseViesResponse({
        countryCode: 'DE',
        vatNumber: '123456789',
        requestDate: '2026-10-15T09:12:00.000Z',
        valid: true,
        requestIdentifier: 'f0f61eb1-0000-4000-8000-000000000000',
        name: 'Muster GmbH',
        address: 'Musterstr. 1, Berlin',
        traderName: '---',
        traderNameMatch: 'NOT_PROCESSED',
      }),
    ).toEqual({
      status: 'VALID',
      valid: true,
      name: 'Muster GmbH',
      address: 'Musterstr. 1, Berlin',
      request_identifier: 'f0f61eb1-0000-4000-8000-000000000000',
      request_date: '2026-10-15T09:12:00.000Z',
      error_code: null,
    });
  });

  it('valid without a requester: empty identifier and "---" become null', () => {
    const r = parseViesResponse({
      countryCode: 'DE',
      vatNumber: '123456789',
      requestDate: '2026-10-15T09:12:00.000Z',
      valid: true,
      requestIdentifier: '',
      name: '---',
      address: '---',
    });
    expect(r).toMatchObject({
      status: 'VALID',
      name: null,
      address: null,
      request_identifier: null,
    });
  });

  it('valid:false is INVALID', () => {
    expect(
      parseViesResponse({ countryCode: 'DE', vatNumber: '1', valid: false })
        .status,
    ).toBe('INVALID');
  });

  it('INVALID_INPUT (HTTP 200 envelope) is INVALID', () => {
    expect(
      parseViesResponse({
        actionSucceed: false,
        errorWrappers: [{ error: 'INVALID_INPUT' }],
      }),
    ).toMatchObject({ status: 'INVALID', error_code: 'INVALID_INPUT' });
  });

  it.each([
    'MS_UNAVAILABLE',
    'TIMEOUT',
    'SERVICE_UNAVAILABLE',
    'GLOBAL_MAX_CONCURRENT_REQ',
    'MS_MAX_CONCURRENT_REQ',
    'INVALID_REQUESTER_INFO',
    'VAT_BLOCKED',
    'IP_BLOCKED',
  ])('%s envelope is UNAVAILABLE', (code) => {
    expect(
      parseViesResponse({
        actionSucceed: false,
        errorWrappers: [{ error: code }],
      }),
    ).toMatchObject({ status: 'UNAVAILABLE', valid: false, error_code: code });
  });

  it('garbage is UNAVAILABLE, never a throw', () => {
    expect(parseViesResponse(null).status).toBe('UNAVAILABLE');
    expect(parseViesResponse('x').status).toBe('UNAVAILABLE');
    expect(parseViesResponse({}).error_code).toBe('MALFORMED_RESPONSE');
    expect(parseViesResponse({ actionSucceed: false }).error_code).toBe(
      'UNKNOWN_ERROR',
    );
  });
});

describe('member-state codes', () => {
  it('maps Greece to EL and back', () => {
    expect(toViesCountry('GR')).toBe('EL');
    expect(toViesCountry('EL')).toBe('EL');
    expect(viesCountryToIso('EL')).toBe('GR');
    expect(viesCountryToIso('XI')).toBe('XI');
    expect(splitViesNumber('GR123456789')).toEqual({
      countryCode: 'EL',
      number: '123456789',
    });
  });

  it('knows the EU + XI prefixes only', () => {
    for (const p of ['SE', 'DE', 'EL', 'GR', 'XI', 'FR']) {
      expect(isEuVatPrefix(p)).toBe(true);
    }
    for (const p of ['NO', 'CH', 'GB', 'US', '', null]) {
      expect(isEuVatPrefix(p)).toBe(false);
    }
  });
});
