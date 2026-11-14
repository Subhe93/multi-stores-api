import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  ExportConsentLogQueryDto,
  ListConsentLogQueryDto,
  LogConsentDto,
} from './consent-log.dto';

// Same options as the global pipe in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const valid = () => ({
  event_id: '3b241101-e2bb-4255-8caf-4136c566a962',
  consent_id: '9f1c2a7e-5d4b-4c3a-8b2a-1e0f9d8c7b6a',
  action: 'save',
  source: 'dialog',
  analytics: true,
  marketing: false,
  external_media: null,
  consent_version: '3',
  vendors: ['ga4', 'clarity'],
  text_hash: 'a'.repeat(64),
  locale: 'sv',
});

async function body(value: unknown): Promise<unknown> {
  return (await pipe.transform(value, {
    type: 'body',
    metatype: LogConsentDto,
  })) as unknown;
}

describe('LogConsentDto', () => {
  it('accepts a valid decision', async () => {
    await expect(body(valid())).resolves.toBeInstanceOf(LogConsentDto);
  });

  it.each([['legacy'], ['unavailable'], ['facade']])(
    'accepts text_hash %p',
    async (text_hash) => {
      await expect(body({ ...valid(), text_hash })).resolves.toBeDefined();
    },
  );

  it('accepts a region locale and omitted booleans', async () => {
    const v: Record<string, unknown> = { ...valid(), locale: 'sv-SE' };
    delete v.analytics;
    await expect(body(v)).resolves.toBeDefined();
  });

  it.each([
    ['bad event uuid', { event_id: 'not-a-uuid' }],
    ['bad consent uuid', { consent_id: '1234' }],
    ['unknown action', { action: 'grant_everything' }],
    ['unknown source', { source: 'api' }],
    ['unknown vendor', { vendors: ['ga4', 'hotjar'] }],
    ['duplicate vendor', { vendors: ['ga4', 'ga4'] }],
    [
      'too many vendors',
      { vendors: ['ga4', 'clarity', 'meta', 'tiktok', 'ga4'] },
    ],
    ['non-boolean analytics', { analytics: 'yes' }],
    ['bad version', { consent_version: 'v3' }],
    ['long version', { consent_version: '12345' }],
    ['bad text hash', { text_hash: 'abc' }],
    ['upper-case hash', { text_hash: 'A'.repeat(64) }],
    ['bad locale', { locale: 'swedish' }],
  ])('400 for %s', async (_label, patch) => {
    await expect(body({ ...valid(), ...patch })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([['ip'], ['user_agent'], ['url']])(
    '400 for an extra field %p (no raw IP / UA / URL can be smuggled in)',
    async (field) => {
      await expect(body({ ...valid(), [field]: 'x' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
});

describe('owner query DTOs', () => {
  it('list: limit 1..100, UUID consent_id', async () => {
    const q = (value: unknown) =>
      pipe.transform(value, {
        type: 'query',
        metatype: ListConsentLogQueryDto,
      });
    await expect(q({ limit: '20' })).resolves.toMatchObject({ limit: 20 });
    await expect(q({ limit: '0' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(q({ limit: '101' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(q({ consent_id: 'abc' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(q({ before: 'yesterday' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('export: from and to are required', async () => {
    const q = (value: unknown) =>
      pipe.transform(value, {
        type: 'query',
        metatype: ExportConsentLogQueryDto,
      });
    await expect(q({ from: '2026-01-01' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      q({ from: '2026-01-01', to: '2026-03-31' }),
    ).resolves.toBeDefined();
  });
});
