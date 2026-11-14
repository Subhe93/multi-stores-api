import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateProductDto } from './dto/product.dto';
import {
  PRODUCT_STORY_MAX_PER_PRODUCT,
  normalizeStoryInputs,
  normalizeStoryText,
  storyUnchanged,
} from './product-stories';
import { normalizeVideoInputs } from './products.service';

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

  it('autoplay / loop: absent stays undefined, sent values kept, image forced false', () => {
    const [absent, sent, image] = normalizeStoryInputs([
      base,
      { ...base, autoplay: true, loop: false },
      {
        kind: 'image',
        url: '/uploads/products/a.webp',
        name: 'Bo',
        translations: [],
        autoplay: true,
        loop: true,
      },
    ] as never);
    expect('autoplay' in absent).toBe(false);
    expect('loop' in absent).toBe(false);
    expect(sent).toMatchObject({ autoplay: true, loop: false });
    expect(image).toMatchObject({ autoplay: false, loop: false });
  });

  it('storyUnchanged treats an absent autoplay / loop as equal to the stored value', () => {
    const [next] = normalizeStoryInputs([base] as never);
    const stored = {
      id: 's1',
      ...next,
      autoplay: true,
      loop: true,
    } as never;
    expect(storyUnchanged(stored, next)).toBe(true);
    expect(storyUnchanged(stored, { ...next, autoplay: false })).toBe(false);
    expect(storyUnchanged(stored, { ...next, loop: true })).toBe(true);
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

  it('accepts optional boolean autoplay / loop, rejects other types', () => {
    expect(errors([{ ...base, autoplay: true, loop: false }])).toEqual([]);
    expect(errors([{ ...base, autoplay: 'yes' }])).not.toEqual([]);
    expect(errors([{ ...base, loop: 1 }])).not.toEqual([]);
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

describe('ProductVideoInputDto (featured / autoplay shape guard)', () => {
  const errors = (videos: unknown) =>
    validateSync(plainToInstance(UpdateProductDto, { videos }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  const yt = { kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' };

  it('position 0 is accepted, negative is rejected', () => {
    expect(errors([{ ...yt, position: 0 }])).toEqual([]);
    expect(errors([{ ...yt, position: -1 }])).not.toEqual([]);
  });

  it('autoplay / loop are optional booleans', () => {
    expect(
      errors([{ ...yt, position: 1, autoplay: true, loop: true }]),
    ).toEqual([]);
    expect(errors([{ ...yt, position: 1, autoplay: 'on' }])).not.toEqual([]);
  });
});

describe('normalizeVideoInputs (featured / autoplay)', () => {
  const yt = (over: Record<string, unknown> = {}) => ({
    kind: 'youtube',
    url: 'https://youtu.be/dQw4w9WgXcQ',
    position: 1,
    ...over,
  });

  it('VIDEO_FEATURED_MULTIPLE / VIDEO_FEATURED_REQUIRES_POSTER', () => {
    const poster = '/uploads/products/p.webp';
    expect(
      codeOf(() =>
        normalizeVideoInputs([
          yt({ position: 0, poster_url: poster }),
          yt({ position: 0, poster_url: poster }),
        ] as never),
      ),
    ).toMatchObject({ code: 'VIDEO_FEATURED_MULTIPLE' });
    expect(
      codeOf(() =>
        normalizeVideoInputs([yt(), yt(), yt({ position: 0 })] as never),
      ),
    ).toMatchObject({ code: 'VIDEO_FEATURED_REQUIRES_POSTER', index: 2 });
    expect(
      normalizeVideoInputs([
        yt({ position: 0, poster_url: poster }),
      ] as never)[0].position,
    ).toBe(0);
  });

  it('absent autoplay / loop stay undefined; sent values are kept', () => {
    const [absent, sent] = normalizeVideoInputs([
      yt(),
      yt({ autoplay: true, loop: false }),
    ] as never);
    expect('autoplay' in absent).toBe(false);
    expect('loop' in absent).toBe(false);
    expect(sent).toMatchObject({ autoplay: true, loop: false });
  });
});
