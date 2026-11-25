import { BadRequestException } from '@nestjs/common';

// M171: plain-text rules of a review (title, body, display name, owner
// reply). Pure. Text is stored as typed: tags stay literal characters and
// are never stripped, because every reader renders the text as text.

export const REVIEW_LIMITS = {
  rating_min: 1,
  rating_max: 5,
  title_max: 120,
  body_min: 10,
  body_max: 2000,
  display_name_min: 2,
  display_name_max: 60,
  reply_max: 1000,
  max_links: 2,
} as const;

export const REVIEW_LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** A character class from code point ranges (keeps this file plain ASCII). */
function charClass(ranges: ReadonlyArray<readonly [number, number]>): RegExp {
  const hex = (n: number) => `\\u{${n.toString(16)}}`;
  const body = ranges
    .map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`))
    .join('');
  return new RegExp(`[${body}]`, 'gu');
}

// Bidi overrides / isolates and zero-width characters (name spoofing, broken
// layout on RTL pages): U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF.
const INVISIBLE_RE = charClass([
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
]);
// Control characters (C0, DEL, C1) except the line feed, handled per field.
const CONTROL_RE = charClass([
  [0x00, 0x09],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
]);
const NBSP = String.fromCodePoint(0xa0);
const TRAILING_SPACE_RE = new RegExp(`[ ${NBSP}]+\\n`, 'g');
const LINK_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;

/** Length in characters (code points), as a reader counts them. */
export function textLength(value: string): number {
  return [...value].length;
}

/**
 * Normalised form of a text field: NFC, CRLF -> LF, control characters
 * removed (a tab becomes a space), bidi overrides and zero-width characters
 * removed, at most two consecutive newlines, trimmed. A single-line field
 * (title, display name) has its newlines turned into spaces.
 */
export function normalizeReviewText(
  value: unknown,
  opts: { multiline: boolean },
): string {
  if (typeof value !== 'string') return '';
  let s = value.normalize('NFC');
  s = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  s = s.replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
  if (opts.multiline) {
    // Trailing spaces of a line never count; three or more newlines are two.
    s = s.replace(TRAILING_SPACE_RE, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\n+/g, ' ').replace(/ {2,}/g, ' ');
  }
  return s.trim();
}

/** Number of links (`http(s)://...`, `www....`) in a text. */
export function countLinks(value: string): number {
  return value.match(LINK_RE)?.length ?? 0;
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

/**
 * True when a display name may be shown publicly: 2..60 characters, at least
 * one letter, and nothing that looks like an email, a link or a phone number.
 */
export function isDisplayNameAllowed(name: string): boolean {
  const len = textLength(name);
  if (
    len < REVIEW_LIMITS.display_name_min ||
    len > REVIEW_LIMITS.display_name_max
  ) {
    return false;
  }
  if (!/\p{L}/u.test(name)) return false;
  if (/@|http|www\.|:\/\//i.test(name)) return false;
  if ((name.match(/\p{Nd}/gu)?.length ?? 0) >= 6) return false;
  return true;
}

/**
 * Suggested public name of a customer: first name + first letter of the
 * surname ("Anna S."), the first name alone without a surname, and an empty
 * string when both are empty (guest records), so the form asks for it. Never
 * derived from the email or the company name. A stored name that would not
 * pass the display-name rule (e.g. an email typed as a name) suggests nothing.
 */
export function displayNameSuggestion(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  const first = normalizeReviewText(firstName ?? '', { multiline: false });
  const last = normalizeReviewText(lastName ?? '', { multiline: false });
  if (!first) return '';
  const initial = [...last].find((ch) => /\p{L}/u.test(ch));
  const name = initial ? `${first} ${initial.toUpperCase()}.` : first;
  const capped = [...name].slice(0, REVIEW_LIMITS.display_name_max).join('');
  return isDisplayNameAllowed(capped) ? capped : '';
}

/** The fields of a submission as sent by the form. */
export interface ReviewTextInput {
  rating: unknown;
  title?: unknown;
  body: unknown;
  display_name: unknown;
  locale: unknown;
}

/** A submission that passed every rule, in its stored form. */
export interface NormalizedReview {
  rating: number;
  title: string | null;
  body: string;
  display_name: string;
  locale: string;
}

/**
 * Normalises and checks a submission; throws the coded 400 of the first
 * broken rule (REVIEW_RATING_INVALID, REVIEW_TITLE_TOO_LONG,
 * REVIEW_BODY_TOO_SHORT / _TOO_LONG, REVIEW_DISPLAY_NAME_INVALID,
 * REVIEW_LOCALE_INVALID, REVIEW_TEXT_INVALID).
 */
export function normalizeReviewInput(input: ReviewTextInput): NormalizedReview {
  const rating = input.rating;
  if (
    typeof rating !== 'number' ||
    !Number.isInteger(rating) ||
    rating < REVIEW_LIMITS.rating_min ||
    rating > REVIEW_LIMITS.rating_max
  ) {
    throw invalid('REVIEW_RATING_INVALID', 'Choose a rating from 1 to 5.');
  }

  const title = normalizeReviewText(input.title ?? '', { multiline: false });
  if (textLength(title) > REVIEW_LIMITS.title_max) {
    throw invalid(
      'REVIEW_TITLE_TOO_LONG',
      `The title can be at most ${REVIEW_LIMITS.title_max} characters.`,
    );
  }

  const body = normalizeReviewText(input.body, { multiline: true });
  const bodyLength = textLength(body);
  if (bodyLength < REVIEW_LIMITS.body_min) {
    throw invalid(
      'REVIEW_BODY_TOO_SHORT',
      `Write at least ${REVIEW_LIMITS.body_min} characters.`,
    );
  }
  if (bodyLength > REVIEW_LIMITS.body_max) {
    throw invalid(
      'REVIEW_BODY_TOO_LONG',
      `The review can be at most ${REVIEW_LIMITS.body_max} characters.`,
    );
  }

  const displayName = normalizeReviewText(input.display_name, {
    multiline: false,
  });
  if (!isDisplayNameAllowed(displayName)) {
    throw invalid(
      'REVIEW_DISPLAY_NAME_INVALID',
      'Enter a name of 2 to 60 characters without an email, link or phone number.',
    );
  }

  const locale = typeof input.locale === 'string' ? input.locale.trim() : '';
  if (!REVIEW_LOCALE_RE.test(locale)) {
    throw invalid('REVIEW_LOCALE_INVALID', 'Unknown language code.');
  }

  if (countLinks(`${title}\n${body}`) > REVIEW_LIMITS.max_links) {
    throw invalid(
      'REVIEW_TEXT_INVALID',
      `A review can contain at most ${REVIEW_LIMITS.max_links} links.`,
    );
  }

  return {
    rating,
    title: title || null,
    body,
    display_name: displayName,
    locale,
  };
}

/** Normalised owner reply (1..1000 characters) or 400 REVIEW_REPLY_INVALID. */
export function normalizeReviewReply(value: unknown): string {
  const reply = normalizeReviewText(value, { multiline: true });
  const length = textLength(reply);
  if (length < 1 || length > REVIEW_LIMITS.reply_max) {
    throw invalid(
      'REVIEW_REPLY_INVALID',
      `A reply must be 1 to ${REVIEW_LIMITS.reply_max} characters.`,
    );
  }
  return reply;
}

/** Reviews per page of the public read (fixed in v1). */
export const REVIEWS_PAGE_SIZE = 10;
/** Highest page the public read serves. */
export const REVIEWS_MAX_PAGE = 200;

/** `?page=` of the public read: an integer 1..200, anything else is 1. */
export function parseReviewsPage(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return 1;
  const page = Number(raw);
  return page >= 1 && page <= REVIEWS_MAX_PAGE ? page : 1;
}
