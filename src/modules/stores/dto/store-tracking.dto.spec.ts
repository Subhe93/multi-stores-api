import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateStoreDto } from './store.dto';

// Tracking ids on PUT /stores/my/store (Namez go-live 3.9): GA4 measurement
// id, Meta pixel id (digits), TikTok pixel id, plus the consent toggle.

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(UpdateStoreDto, body), {
    skipMissingProperties: true,
  });
  return errors.map((e) => e.property);
}

describe('UpdateStoreDto tracking ids (3.9)', () => {
  it('accepts a GA4 measurement id of the form G-XXXXXXXX (or empty to clear)', async () => {
    for (const ok of [
      'G-ABCD1234',
      'G-1234',
      'g-abcd1234',
      'G-XYZ123456789',
      '',
      null,
    ]) {
      expect(await errorsFor({ ga4_measurement_id: ok })).toEqual([]);
    }
    for (const bad of [
      'UA-12345-1',
      'G-ABC',
      'G-123',
      'GTM-ABCD',
      'abc',
      12,
      true,
    ]) {
      expect(await errorsFor({ ga4_measurement_id: bad })).toEqual([
        'ga4_measurement_id',
      ]);
    }
  });

  it('accepts a Meta pixel id made of digits only (or empty to clear)', async () => {
    for (const ok of ['123456789012345', '12345', '', null]) {
      expect(await errorsFor({ meta_pixel_id: ok })).toEqual([]);
    }
    for (const bad of ['1234', 'abc123', '12 34', 123456, true]) {
      expect(await errorsFor({ meta_pixel_id: bad })).toEqual([
        'meta_pixel_id',
      ]);
    }
  });

  it('accepts a TikTok pixel id of letters and digits (or empty to clear)', async () => {
    for (const ok of [
      'CABCDEF1234567890',
      'ABCDEFGH',
      'cabcdef1234567890',
      '',
      null,
    ]) {
      expect(await errorsFor({ tiktok_pixel_id: ok })).toEqual([]);
    }
    for (const bad of ['short', 'has-dash1', 'has space1', 1234567890, true]) {
      expect(await errorsFor({ tiktok_pixel_id: bad })).toEqual([
        'tiktok_pixel_id',
      ]);
    }
  });

  it('accepts only a boolean for consent_required', async () => {
    for (const ok of [true, false]) {
      expect(await errorsFor({ consent_required: ok })).toEqual([]);
    }
    for (const bad of ['true', 1, 'yes']) {
      expect(await errorsFor({ consent_required: bad })).toEqual([
        'consent_required',
      ]);
    }
  });
});
