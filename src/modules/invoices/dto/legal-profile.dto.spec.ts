import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateLegalProfileDto } from './legal-profile.dto';

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(UpdateLegalProfileDto, body));
  return errors.map((e) => e.property);
}

describe('UpdateLegalProfileDto', () => {
  it('logo_url accepts only /uploads/ paths (null / empty clear it)', async () => {
    expect(await errorsFor({ logo_url: '/uploads/general/logo.webp' })).toEqual(
      [],
    );
    expect(await errorsFor({ logo_url: null })).toEqual([]);
    expect(await errorsFor({ logo_url: '' })).toEqual([]);
    expect(
      await errorsFor({ logo_url: 'https://cdn.example.com/x.png' }),
    ).toEqual(['logo_url']);
    expect(await errorsFor({ logo_url: 'data:image/png;base64,AAAA' })).toEqual(
      ['logo_url'],
    );
  });

  it('checks country code, due days and email formats', async () => {
    expect(
      await errorsFor({ country_code: 'se', due_days: 121, email: 'nope' }),
    ).toEqual(expect.arrayContaining(['country_code', 'due_days', 'email']));
    expect(
      await errorsFor({ country_code: 'SE', due_days: 30, email: 'a@b.se' }),
    ).toEqual([]);
  });
});
