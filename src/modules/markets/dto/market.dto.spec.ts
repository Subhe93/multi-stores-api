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
