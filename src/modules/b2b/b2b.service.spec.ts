import { BadRequestException } from '@nestjs/common';
import { B2bService } from './b2b.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { DEFAULT_B2B_SETTINGS } from './b2b-settings';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompanyDto } from './dto/b2b.dto';
import { CreateOrderDto } from '../orders/dto/order.dto';
import { UpdateCustomerDto } from '../customers/dto/create-customer.dto';

// The buyer-type gate (D1) and the company validation (D7) against a
// stubbed StoreAppsService: the app's state and settings are the only inputs.

const STORE_ID = 's1';

function build(opts: { enabled: boolean; settings?: unknown }) {
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled)),
    getSettings: jest.fn(() =>
      Promise.resolve(opts.enabled ? (opts.settings ?? {}) : null),
    ),
  };
  const service = new B2bService(storeApps as unknown as StoreAppsService);
  return { service, storeApps };
}

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? Promise.resolve().then(p) : p);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as unknown as string;
  }
  throw new Error('expected a rejection');
}

describe('B2bService.resolveBuyerType', () => {
  it('PERSON when the app is off, whatever was requested', async () => {
    const { service, storeApps } = build({ enabled: false });
    expect(await service.resolveBuyerType(STORE_ID, 'COMPANY')).toBe('PERSON');
    expect(await service.resolveBuyerType(STORE_ID, 'PERSON')).toBe('PERSON');
    expect(await service.resolveBuyerType(STORE_ID, null)).toBe('PERSON');
    // Nothing is read for a request that did not ask for COMPANY.
    expect(storeApps.isEnabled).toHaveBeenCalledTimes(1);
  });

  it('PERSON when allow_company is false', async () => {
    const { service } = build({
      enabled: true,
      settings: { allow_company: false },
    });
    expect(await service.resolveBuyerType(STORE_ID, 'COMPANY')).toBe('PERSON');
  });

  it('COMPANY when the app is on and asked for', async () => {
    const { service } = build({ enabled: true });
    expect(await service.resolveBuyerType(STORE_ID, 'COMPANY')).toBe('COMPANY');
    expect(await service.resolveBuyerType(STORE_ID, 'company')).toBe('PERSON');
    expect(await service.resolveBuyerType(STORE_ID)).toBe('PERSON');
  });

  it('getSettings merges defaults (defaults when off)', async () => {
    expect(
      await build({ enabled: false }).service.getSettings(STORE_ID),
    ).toEqual(DEFAULT_B2B_SETTINGS);
    expect(
      await build({
        enabled: true,
        settings: { require_vat_number: true },
      }).service.getSettings(STORE_ID),
    ).toEqual({ ...DEFAULT_B2B_SETTINGS, require_vat_number: true });
  });

  it('kustomCustomerTypes: both kinds only when company purchases are accepted', async () => {
    expect(
      await build({ enabled: false }).service.kustomCustomerTypes(STORE_ID),
    ).toBeUndefined();
    expect(
      await build({
        enabled: true,
        settings: { allow_company: false },
      }).service.kustomCustomerTypes(STORE_ID),
    ).toBeUndefined();
    expect(
      await build({ enabled: true }).service.kustomCustomerTypes(STORE_ID),
    ).toEqual(['person', 'organization']);
  });
});

describe('B2bService.validateCompany', () => {
  const { service } = build({ enabled: true });
  const settings = { ...DEFAULT_B2B_SETTINGS };
  const valid = {
    company_name: '  Neronet  Academy AB ',
    org_number: '5560360793',
    vat_number: 'se 5566 7788 9901',
    buyer_reference: ' Anna ',
  };

  it('returns the normalised snapshot', () => {
    expect(service.validateCompany(valid, 'SE', settings)).toEqual({
      customer_type: 'COMPANY',
      company_name: 'Neronet Academy AB',
      org_number: '556036-0793',
      vat_number: 'SE556677889901',
      buyer_reference: 'Anna',
    });
    expect(
      service.validateCompany(
        { company_name: 'X', org_number: 'HRB 1' },
        'DE',
        settings,
      ),
    ).toEqual({
      customer_type: 'COMPANY',
      company_name: 'X',
      org_number: 'HRB 1',
      vat_number: null,
      buyer_reference: null,
    });
  });

  it('throws each B2B_* code', async () => {
    expect(
      await codeOf(() =>
        service.validateCompany(
          { ...valid, company_name: ' ' },
          'SE',
          settings,
        ),
      ),
    ).toMatchObject({ code: 'B2B_COMPANY_NAME_REQUIRED' });
    expect(
      await codeOf(() => service.validateCompany(undefined, 'SE', settings)),
    ).toMatchObject({ code: 'B2B_COMPANY_NAME_REQUIRED' });
    expect(
      await codeOf(() =>
        service.validateCompany({ ...valid, org_number: '' }, 'SE', settings),
      ),
    ).toMatchObject({ code: 'B2B_ORG_NUMBER_REQUIRED' });
    expect(
      await codeOf(() =>
        service.validateCompany(
          { ...valid, org_number: '559123-4567' },
          'SE',
          settings,
        ),
      ),
    ).toMatchObject({
      code: 'B2B_ORG_NUMBER_INVALID',
      message: expect.stringContaining('NNNNNN-NNNN') as string,
    });
    expect(
      await codeOf(() =>
        service.validateCompany(
          { ...valid, vat_number: 'SE123' },
          'SE',
          settings,
        ),
      ),
    ).toMatchObject({ code: 'B2B_VAT_NUMBER_INVALID' });
  });

  it('require_vat_number makes a missing VAT number a 400', async () => {
    const strict = { ...settings, require_vat_number: true };
    expect(
      await codeOf(() =>
        service.validateCompany({ ...valid, vat_number: '' }, 'SE', strict),
      ),
    ).toMatchObject({ code: 'B2B_VAT_NUMBER_REQUIRED' });
    expect(service.validateCompany(valid, 'SE', strict).vat_number).toBe(
      'SE556677889901',
    );
  });

  it('the strict org rule follows org_number_countries', () => {
    const lenient = { ...settings, org_number_countries: [] };
    expect(
      service.validateCompany(
        { ...valid, org_number: '559123-4567' },
        'SE',
        lenient,
      ).org_number,
    ).toBe('559123-4567');
  });

  it('normalizeCompany never throws and lists every problem', () => {
    const r = service.normalizeCompany(
      { company_name: '', org_number: '12', vat_number: 'bad' },
      'SE',
      settings,
    );
    expect(r.errors.map((e) => e.code)).toEqual([
      'B2B_COMPANY_NAME_REQUIRED',
      'B2B_ORG_NUMBER_INVALID',
      'B2B_VAT_NUMBER_INVALID',
    ]);
    expect(r.snapshot).toEqual({
      customer_type: 'COMPANY',
      company_name: '',
      org_number: '12',
      vat_number: 'BAD',
      buyer_reference: null,
    });
  });
});

describe('CompanyDto + validateCompany: missing fields get friendly codes', () => {
  const { service } = build({ enabled: true });
  const settings = { ...DEFAULT_B2B_SETTINGS };

  it('the DTO lets a missing / blank company_name or org_number through', async () => {
    for (const body of [
      {},
      { company_name: '', org_number: '' },
      { company_name: '   ', org_number: '  ' },
    ]) {
      expect(await validate(plainToInstance(CompanyDto, body))).toEqual([]);
    }
    // The bounds still apply.
    const long = await validate(
      plainToInstance(CompanyDto, { company_name: 'x'.repeat(201) }),
    );
    expect(long.map((e) => e.property)).toEqual(['company_name']);
  });

  it('the service then answers with the B2B_* codes', async () => {
    expect(
      await codeOf(() =>
        service.validateCompany({ org_number: '5560360793' }, 'SE', settings),
      ),
    ).toMatchObject({ code: 'B2B_COMPANY_NAME_REQUIRED' });
    expect(
      await codeOf(() =>
        service.validateCompany({ company_name: 'X AB' }, 'SE', settings),
      ),
    ).toMatchObject({ code: 'B2B_ORG_NUMBER_REQUIRED' });
    expect(
      await codeOf(() =>
        service.validateCompany(
          { company_name: 'X AB', org_number: '   ' },
          'SE',
          settings,
        ),
      ),
    ).toMatchObject({ code: 'B2B_ORG_NUMBER_REQUIRED' });
  });
});

describe('IsBuyerType', () => {
  it('names the validated property in its message', async () => {
    const order = await validate(
      plainToInstance(CreateOrderDto, { buyer_type: 'X' }),
    );
    const buyer = order.find((e) => e.property === 'buyer_type');
    expect(Object.values(buyer?.constraints ?? {})).toEqual([
      'buyer_type must be one of PERSON, COMPANY',
    ]);

    const customer = await validate(
      plainToInstance(UpdateCustomerDto, { customer_type: 'X' }),
    );
    expect(customer).toHaveLength(1);
    expect(Object.values(customer[0].constraints ?? {})).toEqual([
      'customer_type must be one of PERSON, COMPANY',
    ]);
  });
});
