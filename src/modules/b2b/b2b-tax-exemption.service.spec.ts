import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { TaxService } from '../taxes/tax.service';
import { B2bService } from './b2b.service';
import { B2bTaxExemptionService } from './b2b-tax-exemption.service';
import { B2bStorefrontController } from './b2b-storefront.controller';
import type { VatEvidence } from './b2b.types';
import { ViesService } from './vies/vies.service';

// prepare() gating, the exemption CRUD and the public vat-check endpoint.

function evidence(status: VatEvidence['status'], vat = 'DE123456789') {
  return {
    source: 'VIES',
    vat_number: vat,
    country_code: vat.slice(0, 2),
    status,
    valid: status === 'valid',
    name: status === 'valid' ? 'Muster GmbH' : null,
    address: 'Musterstr. 1, Berlin',
    request_identifier: null,
    requester: null,
    checked_at: '2026-10-15T09:12:00.000Z',
    check_id: 'chk-1',
    error_code: null,
  } as VatEvidence;
}

function build(opts: {
  enabled?: boolean;
  settings?: Record<string, unknown>;
  vies?: VatEvidence['status'];
}) {
  const enabled = opts.enabled ?? true;
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(enabled)),
    getSettings: jest.fn(() =>
      Promise.resolve(
        enabled ? { reverse_charge_enabled: true, ...opts.settings } : null,
      ),
    ),
  };
  const prisma = {
    storeCustomerTaxExemption: {
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'ex1',
          ...data,
          created_at: new Date('2026-10-15T00:00:00Z'),
          revoked_at: null,
          customer: {
            id: data.customer_id,
            first_name: 'Anna',
            last_name: 'Berg',
            user: { email: 'anna@example.com' },
          },
        }),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'ex1',
          kind: 'FULL',
          vat_number: null,
          note: null,
          created_by: 'u1',
          created_at: new Date('2026-10-15T00:00:00Z'),
          ...data,
          customer: {
            id: 'cust1',
            first_name: 'Anna',
            last_name: 'Berg',
            user: { email: 'anna@example.com' },
          },
        }),
      ),
    },
    order: {
      findFirst: jest.fn(
        (): Promise<unknown> =>
          Promise.resolve({ customer_id: 'cust1', vat_number: 'DE123456789' }),
      ),
    },
    customer: {
      findUnique: jest.fn(() => Promise.resolve({ id: 'cust1' })),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          is_active: true,
          store_type: 'INDEPENDENT',
        }),
      ),
    },
  };
  const vies = {
    check: jest.fn(() => Promise.resolve(evidence(opts.vies ?? 'valid'))),
    requesterFor: jest.fn(() => Promise.resolve(null)),
  };
  const b2b = new B2bService(storeApps as unknown as StoreAppsService);
  const service = new B2bTaxExemptionService(
    prisma as unknown as PrismaService,
    b2b,
    vies as unknown as ViesService,
  );
  return { service, prisma, vies, b2b };
}

describe('B2bTaxExemptionService.prepare', () => {
  it('null while the app or reverse charge is off (no VIES, no DB)', async () => {
    for (const b of [
      build({ enabled: false }),
      build({ settings: { reverse_charge_enabled: false } }),
    ]) {
      const r = await b.service.prepare('s1', {
        buyerType: 'COMPANY',
        vatNumber: 'DE123456789',
        customerId: 'cust1',
        mode: 'live',
      });
      expect(r).toBeNull();
      expect(b.vies.check).not.toHaveBeenCalled();
      expect(
        b.prisma.storeCustomerTaxExemption.findFirst,
      ).not.toHaveBeenCalled();
    }
  });

  it('checks VIES only for a COMPANY with a number', async () => {
    const { service, vies } = build({});
    const person = await service.prepare('s1', {
      buyerType: 'PERSON',
      vatNumber: 'DE123456789',
      mode: 'live',
    });
    expect(person?.vat).toBeNull();
    expect(vies.check).not.toHaveBeenCalled();
    const company = await service.prepare('s1', {
      buyerType: 'COMPANY',
      vatNumber: 'DE123456789',
      mode: 'cached',
    });
    expect(company?.vat?.status).toBe('valid');
    expect(vies.check).toHaveBeenCalledWith(
      'DE123456789',
      expect.objectContaining({ mode: 'cached', source: 'quote' }),
    );
  });

  it("'stored' mode reuses the session evidence, never VIES", async () => {
    const { service, vies } = build({});
    const stored = evidence('valid', 'EL123456789');
    const hit = await service.prepare('s1', {
      buyerType: 'COMPANY',
      vatNumber: 'GR 123456789',
      mode: 'stored',
      stored,
    });
    expect(hit?.vat).toBe(stored);
    const miss = await service.prepare('s1', {
      buyerType: 'COMPANY',
      vatNumber: 'DE123456789',
      mode: 'stored',
      stored,
    });
    expect(miss?.vat).toBeNull();
    expect(vies.check).not.toHaveBeenCalled();
  });

  it('loads the active exemption of a known customer (user id resolved lazily)', async () => {
    const { service, prisma } = build({});
    prisma.storeCustomerTaxExemption.findFirst.mockResolvedValueOnce({
      id: 'ex1',
      kind: 'FULL',
      vat_number: null,
      note: null,
    });
    const r = await service.prepare('s1', {
      buyerType: 'PERSON',
      userId: 'u1',
      mode: 'cached',
    });
    expect(r?.customerExemption?.kind).toBe('FULL');
    expect(prisma.storeCustomerTaxExemption.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { store_id: 's1', customer_id: 'cust1', revoked_at: null },
      }),
    );
  });
});

describe('B2bTaxExemptionService CRUD', () => {
  it('creates from an order of the store, defaulting the VAT number', async () => {
    const { service, prisma } = build({});
    const view = await service.create('s1', 'u1', {
      order_id: 'o1',
      kind: 'REVERSE_CHARGE',
      note: ' VIES down ',
    });
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', store_id: 's1' } }),
    );
    expect(view).toMatchObject({
      id: 'ex1',
      kind: 'REVERSE_CHARGE',
      vat_number: 'DE123456789',
      note: 'VIES down',
      created_by: 'u1',
      customer: { id: 'cust1', email: 'anna@example.com' },
    });
  });

  it('404 B2B_EXEMPTION_CUSTOMER_NOT_FOUND without an order in the store', async () => {
    const { service, prisma } = build({});
    prisma.order.findFirst.mockResolvedValue(null);
    await expect(
      service.create('s1', 'u1', { customer_id: 'x', kind: 'FULL' }),
    ).rejects.toMatchObject({
      response: { code: 'B2B_EXEMPTION_CUSTOMER_NOT_FOUND' },
    });
    await expect(
      service.create('s1', 'u1', { kind: 'FULL' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('400 B2B_EXEMPTION_VAT_REQUIRED for reverse charge without an EU number', async () => {
    const { service, prisma } = build({});
    prisma.order.findFirst.mockResolvedValue({
      customer_id: 'cust1',
      vat_number: null,
    });
    await expect(
      service.create('s1', 'u1', { order_id: 'o1', kind: 'REVERSE_CHARGE' }),
    ).rejects.toMatchObject({
      response: { code: 'B2B_EXEMPTION_VAT_REQUIRED' },
    });
    await expect(
      service.create('s1', 'u1', {
        order_id: 'o1',
        kind: 'REVERSE_CHARGE',
        vat_number: 'NO123456789MVA',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('409 B2B_EXEMPTION_EXISTS (pre-check and unique-index race)', async () => {
    const { service, prisma } = build({});
    prisma.storeCustomerTaxExemption.findFirst.mockResolvedValueOnce({
      id: 'old',
    });
    await expect(
      service.create('s1', 'u1', { order_id: 'o1', kind: 'FULL' }),
    ).rejects.toMatchObject({ response: { code: 'B2B_EXEMPTION_EXISTS' } });
    prisma.storeCustomerTaxExemption.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await expect(
      service.create('s1', 'u1', { order_id: 'o1', kind: 'FULL' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('revoke is soft; unknown id is B2B_EXEMPTION_NOT_FOUND', async () => {
    const { service, prisma } = build({});
    await expect(service.revoke('s1', 'u1', 'nope')).rejects.toMatchObject({
      response: { code: 'B2B_EXEMPTION_NOT_FOUND' },
    });
    prisma.storeCustomerTaxExemption.findFirst.mockResolvedValueOnce({
      id: 'ex1',
    });
    const view = await service.revoke('s1', 'u2', 'ex1');
    const updateArg = (
      prisma.storeCustomerTaxExemption.update.mock.calls[0] as unknown as [
        { data: { revoked_at: unknown; revoked_by: string } },
      ]
    )[0];
    expect(updateArg.data.revoked_at).toBeInstanceOf(Date);
    expect(updateArg.data.revoked_by).toBe('u2');
    expect(view.revoked_at).toBeInstanceOf(Date);
  });
});

describe('POST /storefront/:slug/b2b/vat-check', () => {
  function controller(b: ReturnType<typeof build>) {
    const taxes = {
      contextFor: jest.fn(() =>
        Promise.resolve({ registrant: 'STORE', taxCountry: 'SE' }),
      ),
    };
    return {
      ctl: new B2bStorefrontController(
        b.prisma as unknown as PrismaService,
        taxes as unknown as TaxService,
        b.b2b,
        b.service,
      ),
      taxes,
    };
  }

  it('disabled (app or setting off): no VIES call', async () => {
    for (const b of [
      build({ enabled: false }),
      build({ settings: { reverse_charge_enabled: false } }),
    ]) {
      const r = await controller(b).ctl.vatCheck('namez', {
        vat_number: 'de 123 456 789',
        country_code: 'de',
      });
      expect(r).toEqual({
        vat_number: 'DE123456789',
        country_code: 'DE',
        status: 'disabled',
        name: null,
        checked_at: null,
        reverse_charge: null,
        why: null,
      });
      expect(b.vies.check).not.toHaveBeenCalled();
    }
  });

  it('valid DE number to DE: reverse charge, address never returned', async () => {
    const b = build({});
    const r = await controller(b).ctl.vatCheck('namez', {
      vat_number: 'DE123456789',
      country_code: 'DE',
    });
    expect(r).toEqual({
      vat_number: 'DE123456789',
      country_code: 'DE',
      status: 'valid',
      name: 'Muster GmbH',
      checked_at: '2026-10-15T09:12:00.000Z',
      reverse_charge: true,
      why: null,
    });
    expect(JSON.stringify(r)).not.toContain('Musterstr');
    expect(b.vies.check).toHaveBeenCalledWith(
      'DE123456789',
      expect.objectContaining({ source: 'storefront', mode: 'live' }),
    );
  });

  it('unavailable: reverse_charge false with VAT_UNAVAILABLE', async () => {
    const r = await controller(build({ vies: 'unavailable' })).ctl.vatCheck(
      'namez',
      { vat_number: 'DE123456789', country_code: 'DE' },
    );
    expect(r).toMatchObject({
      status: 'unavailable',
      reverse_charge: false,
      why: 'VAT_UNAVAILABLE',
    });
  });

  it('no destination: reverse_charge null; same country: SAME_COUNTRY', async () => {
    const b = build({});
    const { ctl } = controller(b);
    expect(
      await ctl.vatCheck('namez', { vat_number: 'DE123456789' }),
    ).toMatchObject({ status: 'valid', reverse_charge: null, why: null });
    expect(
      await ctl.vatCheck('namez', {
        vat_number: 'DE123456789',
        country_code: 'SE',
      }),
    ).toMatchObject({ reverse_charge: false, why: 'SAME_COUNTRY' });
  });

  it('404 STORE_NOT_FOUND for an unknown slug', async () => {
    const b = build({});
    b.prisma.store.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      controller(b).ctl.vatCheck('nope', { vat_number: 'DE123456789' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
