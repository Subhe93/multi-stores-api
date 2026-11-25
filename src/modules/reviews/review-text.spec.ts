import { BadRequestException } from '@nestjs/common';
import {
  REVIEW_LIMITS,
  countLinks,
  displayNameSuggestion,
  isDisplayNameAllowed,
  normalizeReviewInput,
  normalizeReviewReply,
  normalizeReviewText,
  parseReviewsPage,
} from './review-text';

const cp = (n: number) => String.fromCodePoint(n);

const valid = {
  rating: 5,
  title: 'Perfect gift',
  body: 'Fast delivery and the engraving looks great.',
  display_name: 'Anna S.',
  locale: 'sv',
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { code?: string })
      .code;
  }
  return undefined;
}

describe('normalizeReviewText', () => {
  it('strips bidi overrides, isolates and zero-width characters', () => {
    const dirty =
      `A${cp(0x200b)}n${cp(0x200f)}n${cp(0x202e)}a` +
      `${cp(0x2066)} S${cp(0x2069)}.${cp(0xfeff)}${cp(0x2060)}`;
    expect(normalizeReviewText(dirty, { multiline: false })).toBe('Anna S.');
  });

  it('strips control characters, turns a tab into a space', () => {
    const dirty = `a${cp(0x00)}b${cp(0x07)}c${cp(0x1b)}d${cp(0x7f)}e${cp(0x85)}f\tg`;
    expect(normalizeReviewText(dirty, { multiline: true })).toBe('abcdef g');
  });

  it('CRLF -> LF, at most two consecutive newlines, trimmed', () => {
    expect(
      normalizeReviewText('  one\r\ntwo\r\n\r\n\r\n\r\nthree  \n\n', {
        multiline: true,
      }),
    ).toBe('one\ntwo\n\nthree');
    expect(normalizeReviewText('a\rb', { multiline: true })).toBe('a\nb');
  });

  it('a single-line field has no newline', () => {
    expect(normalizeReviewText('Anna\n\nS.', { multiline: false })).toBe(
      'Anna S.',
    );
  });

  it('normalises to NFC', () => {
    const decomposed = `Ame${cp(0x301)}lie`;
    const out = normalizeReviewText(decomposed, { multiline: false });
    expect(out).toBe(`Am${cp(0xe9)}lie`);
    expect(out).toHaveLength(6);
  });

  it('keeps tags as literal text (never stripped, never decoded)', () => {
    const body = '<script>alert(1)</script> & <b>bold</b> &lt;';
    expect(normalizeReviewText(body, { multiline: true })).toBe(body);
  });

  it('a non-string is empty', () => {
    expect(normalizeReviewText(undefined, { multiline: true })).toBe('');
    expect(normalizeReviewText(42, { multiline: true })).toBe('');
    expect(normalizeReviewText({ a: 1 }, { multiline: false })).toBe('');
  });
});

describe('normalizeReviewInput', () => {
  it('accepts a valid submission and returns the stored form', () => {
    expect(
      normalizeReviewInput({
        ...valid,
        title: '  Perfect gift ',
        body: `${valid.body}\r\n`,
      }),
    ).toEqual(valid);
  });

  it('an empty or missing title is null', () => {
    expect(normalizeReviewInput({ ...valid, title: '   ' }).title).toBeNull();
    const { title: _t, ...noTitle } = valid;
    void _t;
    expect(normalizeReviewInput(noTitle).title).toBeNull();
  });

  it.each([0, 6, 4.5, -1, '5', null, undefined, NaN])(
    'rating %p -> REVIEW_RATING_INVALID',
    (rating) => {
      expect(codeOf(() => normalizeReviewInput({ ...valid, rating }))).toBe(
        'REVIEW_RATING_INVALID',
      );
    },
  );

  it.each([1, 2, 3, 4, 5])('rating %d is accepted', (rating) => {
    expect(normalizeReviewInput({ ...valid, rating }).rating).toBe(rating);
  });

  it('title over 120 -> REVIEW_TITLE_TOO_LONG (120 passes)', () => {
    expect(
      normalizeReviewInput({ ...valid, title: 'a'.repeat(120) }).title,
    ).toHaveLength(120);
    expect(
      codeOf(() => normalizeReviewInput({ ...valid, title: 'a'.repeat(121) })),
    ).toBe('REVIEW_TITLE_TOO_LONG');
  });

  it('body limits 10..2000 are counted after normalisation', () => {
    expect(
      codeOf(() => normalizeReviewInput({ ...valid, body: 'too short' })),
    ).toBe('REVIEW_BODY_TOO_SHORT');
    // Ten characters padded with invisible ones is still too short.
    expect(
      codeOf(() =>
        normalizeReviewInput({
          ...valid,
          body: `123456789${cp(0x200b).repeat(20)}   `,
        }),
      ),
    ).toBe('REVIEW_BODY_TOO_SHORT');
    expect(normalizeReviewInput({ ...valid, body: '1234567890' }).body).toBe(
      '1234567890',
    );
    expect(
      normalizeReviewInput({ ...valid, body: 'a'.repeat(2000) }).body,
    ).toHaveLength(2000);
    expect(
      codeOf(() => normalizeReviewInput({ ...valid, body: 'a'.repeat(2001) })),
    ).toBe('REVIEW_BODY_TOO_LONG');
    expect(codeOf(() => normalizeReviewInput({ ...valid, body: 12345 }))).toBe(
      'REVIEW_BODY_TOO_SHORT',
    );
  });

  it('lengths count characters, not UTF-16 units', () => {
    const emoji = cp(0x1f600);
    expect(
      normalizeReviewInput({ ...valid, body: emoji.repeat(2000) }).body,
    ).toBe(emoji.repeat(2000));
  });

  it.each([
    'A',
    'a'.repeat(61),
    '12345',
    '...',
    'anna@example.com',
    'Anna http',
    'www.anna.se',
    'x://y',
    'Anna 070123456',
    'Anna 0-7-0-1-2-3',
    '',
  ])('display name %p -> REVIEW_DISPLAY_NAME_INVALID', (display_name) => {
    expect(codeOf(() => normalizeReviewInput({ ...valid, display_name }))).toBe(
      'REVIEW_DISPLAY_NAME_INVALID',
    );
  });

  it.each(['Al', 'Anna S.', 'Anna 12345', 'a'.repeat(60), 'Åsa Ö.'])(
    'display name %p is accepted',
    (display_name) => {
      expect(isDisplayNameAllowed(display_name)).toBe(true);
    },
  );

  it('a display name of only invisible characters is refused', () => {
    expect(
      codeOf(() =>
        normalizeReviewInput({
          ...valid,
          display_name: cp(0x200b).repeat(5) + cp(0x202e),
        }),
      ),
    ).toBe('REVIEW_DISPLAY_NAME_INVALID');
  });

  it.each(['', 'SV', 'swe', 'sv_SE', 'sv-se', 'sv-SEE', 5, null])(
    'locale %p -> REVIEW_LOCALE_INVALID',
    (locale) => {
      expect(codeOf(() => normalizeReviewInput({ ...valid, locale }))).toBe(
        'REVIEW_LOCALE_INVALID',
      );
    },
  );

  it.each(['sv', 'ar', 'de-AT', 'ku'])('locale %p is accepted', (locale) => {
    expect(normalizeReviewInput({ ...valid, locale }).locale).toBe(locale);
  });

  it('more than two links in title + body -> REVIEW_TEXT_INVALID', () => {
    const two = 'See https://a.example and www.b.example for the details.';
    expect(normalizeReviewInput({ ...valid, body: two }).body).toBe(two);
    expect(
      codeOf(() =>
        normalizeReviewInput({
          ...valid,
          title: 'http://c.example',
          body: two,
        }),
      ),
    ).toBe('REVIEW_TEXT_INVALID');
    expect(countLinks('HTTP://A.example WWW.b.example https://c')).toBe(3);
    expect(countLinks('no links here, not even httpx')).toBe(0);
  });

  it('the error body carries a code and a readable message', () => {
    try {
      normalizeReviewInput({ ...valid, rating: 9 });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toEqual({
        code: 'REVIEW_RATING_INVALID',
        message: 'Choose a rating from 1 to 5.',
      });
    }
  });
});

describe('displayNameSuggestion', () => {
  it('first name + last initial', () => {
    expect(displayNameSuggestion('Anna', 'Svensson')).toBe('Anna S.');
    expect(displayNameSuggestion(' anna ', 'svensson')).toBe('anna S.');
    expect(displayNameSuggestion('Åsa', 'öberg')).toBe('Åsa Ö.');
  });

  it('only the first name without a surname', () => {
    expect(displayNameSuggestion('Bertil', '')).toBe('Bertil');
    expect(displayNameSuggestion('Bertil', null)).toBe('Bertil');
    expect(displayNameSuggestion('Bertil', '123')).toBe('Bertil');
  });

  it('empty when both are empty (guest records): the form asks', () => {
    expect(displayNameSuggestion('', '')).toBe('');
    expect(displayNameSuggestion(null, undefined)).toBe('');
    // A surname alone is never shown.
    expect(displayNameSuggestion('', 'Svensson')).toBe('');
  });

  it('never suggests something that looks like an email, link or phone', () => {
    expect(displayNameSuggestion('anna@example.com', 'Svensson')).toBe('');
    expect(displayNameSuggestion('0701234567', '')).toBe('');
    expect(displayNameSuggestion('A', '')).toBe('');
  });

  it('a very long first name is cut to the limit', () => {
    const out = displayNameSuggestion('a'.repeat(100), 'Berg');
    expect([...out]).toHaveLength(REVIEW_LIMITS.display_name_max);
  });
});

describe('normalizeReviewReply', () => {
  it('1..1000 characters, normalised', () => {
    expect(normalizeReviewReply('  Thank you!\r\n')).toBe('Thank you!');
    expect(normalizeReviewReply('a'.repeat(1000))).toHaveLength(1000);
  });

  it.each(['', '   ', cp(0x200b), 'a'.repeat(1001), null, 5])(
    '%p -> REVIEW_REPLY_INVALID',
    (value) => {
      expect(codeOf(() => normalizeReviewReply(value))).toBe(
        'REVIEW_REPLY_INVALID',
      );
    },
  );
});

describe('parseReviewsPage', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    ['200', 200],
    ['007', 7],
  ])('%p -> %d', (raw, page) => {
    expect(parseReviewsPage(raw)).toBe(page);
  });

  it.each([
    undefined,
    '',
    '0',
    '-1',
    '201',
    '9999',
    '1.5',
    'abc',
    '1e2',
    ['2'],
    3,
  ])('junk %p -> 1', (raw) => {
    expect(parseReviewsPage(raw)).toBe(1);
  });
});
