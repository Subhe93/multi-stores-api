import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMarketDto, UpdateMarketDto } from './market.dto';

async function errorsFor(
  cls: typeof CreateMarketDto | typeof UpdateMarketDto,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body), {
    skipMissingProperties: true,
  });
  return errors.map((e) => e.property);
}

describe('Market DTO indexing (M6.1)', () => {
  it.each([CreateMarketDto, UpdateMarketDto])(
    '%p accepts only AUTO | ALWAYS | NEVER',
    async (cls) => {
      for (const ok of ['AUTO', 'ALWAYS', 'NEVER']) {
        expect(await errorsFor(cls, { indexing: ok })).toEqual([]);
      }
      expect(await errorsFor(cls, {})).toEqual([]);
      for (const bad of ['auto', 'SOMETIMES', true, false, 1, '']) {
        expect(await errorsFor(cls, { indexing: bad })).toEqual(['indexing']);
      }
      // `@IsOptional()` lets null through; `MarketsService.normalize` drops it.
      expect(await errorsFor(cls, { indexing: null })).toEqual([]);
      // The old boolean field is gone: it is neither accepted nor validated.
      expect(await errorsFor(cls, { noindex: true })).toEqual([]);
    },
  );
});

describe('Market DTO payment_methods (M157)', () => {
  it.each([CreateMarketDto, UpdateMarketDto])(
    '%p checks the shape only (values are coded in the service)',
    async (cls) => {
      // Omitted, null (clear) and any array up to the abuse cap pass; unknown
      // or non-string values, duplicates and [] are refused later with the
      // coded MARKET_PAYMENT_METHODS_INVALID (not a generic message).
      for (const ok of [
        undefined,
        null,
        ['card'],
        ['kustom', 'cod'],
        [],
        ['x'],
        [1],
        ['card', 'kustom', 'cod', 'card'],
        ['card', 'card', 'kustom', 'cod'],
      ]) {
        expect(
          await errorsFor(cls, ok === undefined ? {} : { payment_methods: ok }),
        ).toEqual([]);
      }
      for (const bad of [
        'card',
        1,
        {},
        Array.from({ length: 21 }, () => 'card'),
      ]) {
        expect(await errorsFor(cls, { payment_methods: bad })).toEqual([
          'payment_methods',
        ]);
      }
    },
  );
});
