import { HTTP_CODE_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { StreamableFile } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import type { Request } from 'express';
import { ROLES_KEY } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { StoresService } from '../stores/stores.service';
import { ConsentLogOwnerController } from './consent-log.owner.controller';
import { ConsentLogService } from './consent-log.service';
import { ConsentLogStorefrontController } from './consent-log.storefront.controller';
import type { LogConsentDto } from './dto/consent-log.dto';

/** A route handler as metadata target (never called unbound). */
function handlerOf(proto: object, name: string): object {
  return Object.getOwnPropertyDescriptor(proto, name)!.value as object;
}

describe('ConsentLogStorefrontController', () => {
  const handler = handlerOf(ConsentLogStorefrontController.prototype, 'log');

  it('POST answers 204 and is throttled at 20/min', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(204);
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(20);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(
      60_000,
    );
  });

  it('passes the client IP and UA to the service (which truncates / hashes them)', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const ctrl = new ConsentLogStorefrontController({
      record,
    } as unknown as ConsentLogService);
    const req = {
      ip: '198.51.100.9',
      headers: { 'user-agent': 'UA/1.0' },
    } as unknown as Request;
    const body = { event_id: 'e' } as LogConsentDto;
    await ctrl.log('namez-se', body, req);
    expect(record).toHaveBeenCalledWith('namez-se', body, {
      ip: '198.51.100.9',
      userAgent: 'UA/1.0',
    });
  });
});

describe('ConsentLogOwnerController', () => {
  function setup() {
    const stores = {
      findStoreIdByCreatorUser: jest.fn((userId: string) =>
        Promise.resolve(userId === 'user-a' ? 'store-a' : 'store-b'),
      ),
    };
    const service = {
      list: jest.fn().mockResolvedValue({ items: [], next_before: null }),
      summary: jest.fn().mockResolvedValue({}),
      exportRange: jest.fn().mockReturnValue({}),
      storeSlug: jest.fn().mockResolvedValue('namez-se'),
      exportCsv: jest.fn(async function* () {
        yield await Promise.resolve('id\r\n');
      }),
    };
    const ctrl = new ConsentLogOwnerController(
      service as unknown as ConsentLogService,
      stores as unknown as StoresService,
    );
    return { ctrl, stores, service };
  }

  it('is creator-only behind JWT + RolesGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ConsentLogOwnerController,
    ) as unknown[];
    expect(guards).toContain(RolesGuard);
    expect(guards).toHaveLength(2);
    expect(Reflect.getMetadata(ROLES_KEY, ConsentLogOwnerController)).toEqual([
      UserRole.CREATOR,
    ]);
  });

  it('list / summary / export always use the caller’s own store', async () => {
    const { ctrl, stores, service } = setup();
    await ctrl.list('user-a', { limit: 10 });
    await ctrl.summary('user-a', {});
    await ctrl.export('user-a', { from: '2026-01-01', to: '2026-03-31' });
    expect(stores.findStoreIdByCreatorUser).toHaveBeenCalledTimes(3);
    expect(service.list).toHaveBeenCalledWith('store-a', { limit: 10 });
    expect(service.summary).toHaveBeenCalledWith('store-a', 30);
    expect(service.exportRange).toHaveBeenCalledWith({
      from: '2026-01-01',
      to: '2026-03-31',
    });

    await ctrl.list('user-b', {});
    expect(service.list).toHaveBeenLastCalledWith('store-b', {});
  });

  it('export is a CSV attachment, throttled at 5/min', async () => {
    const { ctrl, service } = setup();
    expect(
      Reflect.getMetadata(
        `${THROTTLER_LIMIT}default`,
        handlerOf(ConsentLogOwnerController.prototype, 'export'),
      ),
    ).toBe(5);
    const file = await ctrl.export('user-a', {
      from: '2026-01-01',
      to: '2026-03-31',
    });
    expect(file).toBeInstanceOf(StreamableFile);
    const headers = file.getHeaders();
    expect(headers.type).toBe('text/csv; charset=utf-8');
    expect(headers.disposition).toBe(
      'attachment; filename="consent-log-namez-se-2026-01-01-2026-03-31.csv"',
    );
    const chunks: Buffer[] = [];
    for await (const c of file.getStream()) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('﻿id\r\n');
    // Rows are read lazily, for the caller's store only.
    expect(service.exportCsv).toHaveBeenCalledWith('store-a', {});
  });
});
