import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateProductDto } from './dto/product.dto';
import {
  PRODUCT_STORY_MAX_PER_PRODUCT,
  normalizeStoryInputs,
  normalizeStoryText,
} from './product-stories';

const base = {
  kind: 'vimeo' as const,
  url: 'https://player.vimeo.com/video/76979871?h=abcdef1234',
  name: 'Anna',
  translations: [],
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a rejection');
};

describe('normalizeStoryInputs', () => {
  it('stores the canonical watch URL and defaults rating / verified', () => {
    const [s] = normalizeStoryInputs([base as never]);
    expect(s).toMatchObject({
      kind: 'VIMEO',
      url: 'https://vimeo.com/76979871/abcdef1234',
      rating: null,
      verified: false,
      sort_order: 0,
      translations: [],
    });
  });

  it('limit is 30', () => {
    expect(PRODUCT_STORY_MAX_PER_PRODUCT).toBe(30);
    expect(
      codeOf(() =>
        normalizeStoryInputs(Array.from({ length: 31 }, () => base) as never),
      ),
    ).toEqual(
      expect.objectContaining({ code: 'STORY_LIMIT_EXCEEDED', max: 30 }),
    );
  });

  it('cleans text: CRLF, more than two newlines, trimming', () => {
    expect(normalizeStoryText(' a\r\nb\r\n\r\n\r\nc ')).toBe('a\nb\n\nc');
    expect(normalizeStoryText(null)).toBe('');
  });
});

describe('ProductStoryInputDto (shape guard)', () => {
  const errors = (stories: unknown) =>
    validateSync(plainToInstance(UpdateProductDto, { stories }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts a valid story', () => {
    expect(
      errors([
        {
          ...base,
          rating: 5,
          verified: true,
          translations: [{ locale: 'sv', quote: 'Bra', subtitle: null }],
        },
      ]),
    ).toEqual([]);
  });

  it('rating outside 1..5 is rejected (same range as the DB CHECK)', () => {
    expect(errors([{ ...base, rating: 0 }])).not.toEqual([]);
    expect(errors([{ ...base, rating: 6 }])).not.toEqual([]);
    expect(errors([{ ...base, rating: 2.5 }])).not.toEqual([]);
    expect(errors([{ ...base, rating: null }])).toEqual([]);
  });

  it('rejects an unknown kind, a bad locale and too long texts', () => {
    expect(errors([{ ...base, kind: 'tiktok' }])).not.toEqual([]);
    expect(
      errors([{ ...base, translations: [{ locale: 'Swedish', quote: 'x' }] }]),
    ).not.toEqual([]);
    expect(errors([{ ...base, name: 'x'.repeat(81) }])).not.toEqual([]);
    expect(
      errors([
        { ...base, translations: [{ locale: 'sv', quote: 'x'.repeat(1001) }] },
      ]),
    ).not.toEqual([]);
    expect(errors(Array.from({ length: 61 }, () => base))).not.toEqual([]);
  });
});
