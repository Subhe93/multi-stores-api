import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TranslationsService } from './translations.service';
import {
  TranslateTextDto,
  TranslationsController,
} from './translations.controller';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import type { PrismaService } from '../../prisma/prisma.service';

// translate-text: bounded input, supported locales only, a per-user throttle,
// and a reported (not silently echoed) provider failure.

const fetchMock = jest.fn();
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});
beforeEach(() => fetchMock.mockReset());

const reply = (body: unknown, ok = true) =>
  Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  });

describe('TranslateTextDto', () => {
  const errorsOf = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(TranslateTextDto, body))).map(
      (e) => e.property,
    );

  it('accepts a supported pair', async () => {
    expect(
      await errorsOf({ text: 'Hej', source_locale: 'sv', target_locale: 'en' }),
    ).toEqual([]);
  });

  it('rejects unsupported locales and oversized text', async () => {
    expect(
      await errorsOf({
        text: 'x'.repeat(5001),
        source_locale: 'xx',
        target_locale: 'en|de',
      }),
    ).toEqual(['text', 'source_locale', 'target_locale']);
  });
});

describe('translate-text route guards', () => {
  const handler = (
    TranslationsController.prototype as unknown as Record<string, object>
  ).translateText;

  it('throttles per user after the auth guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      UserThrottlerGuard,
    ]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(120);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60000);
  });

  it('the tracker is the user id, falling back to the ip', async () => {
    const tracker = (
      UserThrottlerGuard.prototype as unknown as {
        getTracker: (req: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker;
    await expect(tracker({ user: { id: 'u1' }, ip: '1.2.3.4' })).resolves.toBe(
      'user:u1',
    );
    await expect(tracker({ ip: '1.2.3.4' })).resolves.toBe('1.2.3.4');
  });
});

describe('TranslationsService.translateSingleText', () => {
  const svc = new TranslationsService({} as PrismaService);

  it('returns the provider translation', async () => {
    fetchMock.mockReturnValue(
      reply({ responseStatus: 200, responseData: { translatedText: 'Hello' } }),
    );
    await expect(svc.translateSingleText('Hej', 'sv', 'en')).resolves.toEqual({
      translated: 'Hello',
    });
  });

  it.each([
    ['quota (403)', reply({ responseStatus: 403, responseData: {} })],
    ['HTTP 500', reply(null, false)],
    ['network error', Promise.reject(new Error('ECONNRESET'))],
  ])('%s → 503 TRANSLATION_UNAVAILABLE', async (_name, res) => {
    fetchMock.mockReturnValue(res);
    const err = await svc
      .translateSingleText('Hej', 'sv', 'en')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'TRANSLATION_UNAVAILABLE',
    });
  });

  it('entity flows still keep the source text on a provider failure', async () => {
    fetchMock.mockReturnValue(reply({ responseStatus: 403 }));
    const fields = await (
      svc as unknown as {
        translateFields: (
          s: Record<string, string>,
          a: string,
          b: string,
        ) => Promise<Record<string, string>>;
      }
    ).translateFields({ title: 'Hej' }, 'sv', 'en');
    expect(fields).toEqual({ title: 'Hej' });
  });
});
