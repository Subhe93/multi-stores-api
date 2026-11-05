import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { ProvidersService } from './providers.service';
import { ProvidersController } from './providers.controller';
import type { TraderVatCheckService } from '../stores/trader-vat-check';
import { ROLES_KEY } from '../../common/decorators';

// Provider legal details: reuse of the store trader-details rules, own-record
// scoping, VIES paths (mocked) and the hand-written migration.

const VALID = {
  legal_name: 'Supplier AB',
  business_type: 'company',
  org_number: '556016-0680',
  address_line1: 'Storgatan 1',
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'se',
  phone: '+46 70 123 45 67',
  support_email: 'Info@Supplier.se',
};

function build(opts: { provider?: unknown; vies?: boolean | null } = {}) {
  const provider =
    'provider' in opts ? opts.provider : { id: 'prov-1', legal_details: null };
  const prisma = {
    provider: {
      findUnique: jest.fn(() => Promise.resolve(provider)),
      update: jest.fn((args: { data: { legal_details: unknown } }) =>
        Promise.resolve({ legal_details: args.data.legal_details }),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ require_provider_approval: true }),
      ),
    },
  };
  const vatCheck = {
    check: jest.fn(() =>
      Promise.resolve({
        valid: opts.vies === undefined ? true : opts.vies,
        checked_at: '2026-11-05T10:00:00.000Z',
      }),
    ),
  };
  const service = new ProvidersService(
    prisma as never,
    {} as never,
    {} as never,
    { get: () => undefined } as unknown as ConfigService,
    vatCheck as unknown as TraderVatCheckService,
  );
  return { service, prisma, vatCheck };
}

type UpdateArgs = {
  where: unknown;
  data: { legal_details: Record<string, unknown> };
};
const updateArgs = (b: ReturnType<typeof build>): UpdateArgs =>
  (b.prisma.provider.update.mock.calls[0] as unknown[])[0] as UpdateArgs;

describe('ProvidersService legal details', () => {
  it('GET answers null + incomplete before the first save, scoped to the user', async () => {
    const b = build();
    await expect(b.service.getLegalDetails('user-1')).resolves.toEqual({
      legal_details: null,
      complete: false,
    });
    expect(b.prisma.provider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'user-1' } }),
    );
  });

  it('GET reports complete for a stored valid record', async () => {
    const stored = { ...VALID, country: 'SE', org_number: '5560160680' };
    const b = build({ provider: { id: 'prov-1', legal_details: stored } });
    const res = await b.service.getLegalDetails('user-1');
    expect(res.complete).toBe(true);
    expect(res.legal_details).toEqual(stored);
  });

  it('404s without a provider profile (GET and PUT)', async () => {
    const b = build({ provider: null });
    await expect(b.service.getLegalDetails('u')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      b.service.updateLegalDetails('u', VALID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(b.prisma.provider.update).not.toHaveBeenCalled();
  });

  it('PUT normalises with the trader-details rules and writes the own record only', async () => {
    const b = build();
    const res = await b.service.updateLegalDetails('user-1', VALID);
    expect(b.vatCheck.check).not.toHaveBeenCalled();
    expect(b.prisma.provider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'user-1' } }),
    );
    const call = updateArgs(b);
    expect(call.where).toEqual({ id: 'prov-1' });
    expect(call.data.legal_details).toMatchObject({
      org_number: '5560160680',
      country: 'SE',
      support_email: 'info@supplier.se',
    });
    expect(typeof call.data.legal_details.completed_at).toBe('string');
    expect(res.complete).toBe(true);
  });

  it('PUT rejects invalid fields as TRADER_DETAILS_INVALID (SE Luhn)', async () => {
    const b = build();
    const err = await b.service
      .updateLegalDetails('user-1', {
        ...VALID,
        org_number: '556016-0681',
        support_email: 'nope',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as {
      code: string;
      fields: string[];
    };
    expect(body.code).toBe('TRADER_DETAILS_INVALID');
    expect(body.fields).toEqual(['org_number', 'support_email']);
    expect(b.prisma.provider.update).not.toHaveBeenCalled();
  });

  it('PUT with a VIES-valid VAT number stores the check', async () => {
    const b = build({ vies: true });
    await b.service.updateLegalDetails('user-1', {
      ...VALID,
      vat_number: 'se 556016068001',
    });
    expect(b.vatCheck.check).toHaveBeenCalledWith('SE556016068001');
    const details = updateArgs(b).data.legal_details as {
      vat_check: { valid: unknown };
    };
    expect(details.vat_check.valid).toBe(true);
  });

  it('PUT with a VIES-invalid VAT number answers 400 TRADER_VAT_INVALID and saves nothing', async () => {
    const b = build({ vies: false });
    const err = await b.service
      .updateLegalDetails('user-1', { ...VALID, vat_number: 'SE556016068001' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as {
      code: string;
      fields: string[];
    };
    expect(body.code).toBe('TRADER_VAT_INVALID');
    expect(body.fields).toEqual(['vat_number']);
    expect(b.prisma.provider.update).not.toHaveBeenCalled();
  });

  it('PUT with VIES unavailable stores vat_check.valid = null', async () => {
    const b = build({ vies: null });
    const res = await b.service.updateLegalDetails('user-1', {
      ...VALID,
      vat_number: 'SE556016068001',
    });
    expect(
      (res.legal_details as { vat_check: { valid: unknown } }).vat_check.valid,
    ).toBeNull();
    expect(res.complete).toBe(true);
  });

  it('GET /providers/me carries legal_details_complete', async () => {
    const b = build({
      provider: { id: 'prov-1', verified: true, legal_details: null },
    });
    const me = await b.service.findByUserId('user-1');
    expect(me.legal_details_complete).toBe(false);
    expect(me.approval_required).toBe(true);
  });
});

describe('ProvidersController legal-details routes', () => {
  const reflector = new Reflector();
  const proto = ProvidersController.prototype;

  it('are PROVIDER-only', () => {
    for (const name of ['getMyLegalDetails', 'updateMyLegalDetails'] as const) {
      const handler = Object.getOwnPropertyDescriptor(proto, name)
        ?.value as () => unknown;
      expect(reflector.get(ROLES_KEY, handler)).toEqual([UserRole.PROVIDER]);
    }
  });

  it('pass the caller id (own record only)', async () => {
    const svc = {
      getLegalDetails: jest.fn(() => Promise.resolve({})),
      updateLegalDetails: jest.fn(() => Promise.resolve({})),
    };
    const ctl = new ProvidersController(svc as never);
    await ctl.getMyLegalDetails('user-1');
    await ctl.updateMyLegalDetails('user-1', { legal_name: 'X' });
    expect(svc.getLegalDetails).toHaveBeenCalledWith('user-1');
    expect(svc.updateLegalDetails).toHaveBeenCalledWith('user-1', {
      legal_name: 'X',
    });
  });
});

describe('provider legal details migration', () => {
  const root = join(__dirname, '..', '..', '..');
  const file = join(
    root,
    'prisma',
    'migrations',
    '20261115120000_provider_legal_details',
    'migration.sql',
  );

  it('adds a nullable jsonb column to "Provider"', () => {
    expect(existsSync(file)).toBe(true);
    const sql = readFileSync(file, 'utf8');
    expect(sql).toMatch(
      /ALTER TABLE "Provider" ADD COLUMN "legal_details" JSONB;/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it('is mirrored in schema.prisma', () => {
    const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model Provider {'));
    expect(model.slice(0, model.indexOf('}'))).toMatch(
      /legal_details\s+Json\?/,
    );
  });
});
