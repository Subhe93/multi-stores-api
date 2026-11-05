import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProviderDto } from './dto/create-provider.dto';

// The settings page clears a removed logo with `logo_url: null`.
describe('UpdateProviderDto logo_url', () => {
  it('accepts null (clear) and a string, rejects a non-string', async () => {
    const errs = async (logo_url: unknown) =>
      (await validate(plainToInstance(UpdateProviderDto, { logo_url }))).map(
        (e) => e.property,
      );
    expect(await errs(null)).toEqual([]);
    expect(await errs('/uploads/logo.png')).toEqual([]);
    expect(await errs(42)).toEqual(['logo_url']);
  });
});
