import { normalizeRunOptions } from '../run-options';
import { NAMEZ_RUN_OPTIONS } from '../../adapters/wp-bundle/__fixtures__/fixtures';
import { NAMEZ_2026_PROFILE, NAMEZ_2026_SOURCE } from './namez-2026';

describe('run profile namez-2026 (M4.4 §12.2)', () => {
  it('validates against the run options schema without errors', () => {
    const { errors } = normalizeRunOptions(NAMEZ_2026_PROFILE);
    expect(errors).toEqual([]);
  });

  it('survives normalization unchanged (every key is known and complete)', () => {
    const { options } = normalizeRunOptions(
      JSON.parse(JSON.stringify(NAMEZ_2026_PROFILE)),
    );
    expect(options).toEqual(NAMEZ_2026_PROFILE);
  });

  it('is JSON-serializable as stored on ImportRun.options', () => {
    const roundTrip: unknown = JSON.parse(JSON.stringify(NAMEZ_2026_PROFILE));
    expect(normalizeRunOptions(roundTrip).errors).toEqual([]);
    expect(roundTrip).toEqual(NAMEZ_2026_PROFILE);
  });

  it('leaves the platform category to Mapping review (D23)', () => {
    expect(NAMEZ_2026_PROFILE.platform_category_id).toBeNull();
  });

  it('agrees with the dry-run options used by the adapter fixtures', () => {
    expect(NAMEZ_2026_PROFILE).toMatchObject(
      JSON.parse(JSON.stringify(NAMEZ_RUN_OPTIONS)),
    );
  });

  it('skips 4326 on the source host of the run', () => {
    expect(NAMEZ_2026_PROFILE.skip_ext_ids).toEqual([
      `woo:${NAMEZ_2026_SOURCE.site_host}:product:4326`,
    ]);
  });

  it('a typo would be rejected (the schema is strict)', () => {
    expect(
      normalizeRunOptions({ ...NAMEZ_2026_PROFILE, verify_medias: true })
        .errors,
    ).toEqual(['unknown option: verify_medias']);
  });
});
