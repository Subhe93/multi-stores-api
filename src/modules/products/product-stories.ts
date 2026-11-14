import { BadRequestException } from '@nestjs/common';
import type { ProductStoryInputDto } from './dto/product.dto';
import { parseExternalVideoUrl } from './product-video-url';
import { videoUploadConfig } from '../uploads/video-upload.config';

/** Business limit of customer stories per product (contract S3). */
export const PRODUCT_STORY_MAX_PER_PRODUCT = 30;

/** An uploaded product video file as stored (relative, uuid name, MP4). */
export const PRODUCT_VIDEO_FILE_URL =
  /^\/uploads\/products\/[0-9a-f-]{36}\.mp4$/;

/** A poster: one of our own uploaded images. */
export const PRODUCT_VIDEO_POSTER_URL =
  /^\/uploads\/[a-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(webp|png|jpg|jpeg)$/i;

/** The media of an image story: one of our own uploaded images. */
export const STORY_IMAGE_URL =
  /^\/uploads\/[a-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(webp|png|jpg|jpeg)$/i;

export type ProductStoryKindValue = 'IMAGE' | 'FILE' | 'YOUTUBE' | 'VIMEO';

export interface PreparedProductStoryTranslation {
  locale: string;
  quote: string;
  subtitle: string | null;
}

/** A validated, normalised story of a product save (see prepareStories). */
export interface PreparedProductStory {
  id?: string;
  kind: ProductStoryKindValue;
  url: string;
  poster_url: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  name: string;
  rating: number | null;
  verified: boolean;
  sort_order: number;
  translations: PreparedProductStoryTranslation[];
}

/** Throws a coded 400 (the dashboard opens story `index` when present). */
export function storyError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new BadRequestException({ code, message, ...extra });
}

/**
 * Plain-text cleanup of a quote / subtitle: CRLF -> LF, tabs -> spaces, other
 * C0 control characters and DEL removed, runs of more than two newlines
 * collapsed to two, trimmed. The texts are stored and served as plain text;
 * renderers must output them as text only (never innerHTML / JSON-LD).
 */
export function normalizeStoryText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return (
    raw
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** A story name: one line of plain text (see normalizeStoryText). */
export function normalizeStoryName(raw: unknown): string {
  return normalizeStoryText(raw).replace(/\s*\n\s*/g, ' ');
}

/** A stored story row as syncStories compares it with the payload. */
export interface StoredProductStory {
  id: string;
  kind: ProductStoryKindValue;
  url: string;
  poster_url: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  name: string;
  rating: number | null;
  verified: boolean;
  sort_order: number;
  translations: PreparedProductStoryTranslation[];
}

/**
 * True when saving `next` over `stored` would change nothing (row fields and
 * the set of translations, in any order), so syncStories can skip the update
 * and the translation rewrite.
 */
export function storyUnchanged(
  stored: StoredProductStory,
  next: PreparedProductStory,
): boolean {
  if (
    stored.kind !== next.kind ||
    stored.url !== next.url ||
    stored.poster_url !== next.poster_url ||
    stored.duration_s !== next.duration_s ||
    stored.width !== next.width ||
    stored.height !== next.height ||
    stored.name !== next.name ||
    stored.rating !== next.rating ||
    stored.verified !== next.verified ||
    stored.sort_order !== next.sort_order ||
    stored.translations.length !== next.translations.length
  ) {
    return false;
  }
  const byLocale = new Map(stored.translations.map((t) => [t.locale, t]));
  return next.translations.every((t) => {
    const s = byLocale.get(t.locale);
    return !!s && s.quote === t.quote && (s.subtitle ?? null) === t.subtitle;
  });
}

function isOwnImageUrl(url: string): boolean {
  return STORY_IMAGE_URL.test(url) && !url.includes('..');
}

/**
 * Stateless checks of a `stories` save payload (customer-stories contract
 * 3.2 steps 2-3): the per-product limit, the name, the media shape per kind
 * (YouTube/Vimeo stored as the canonical watch URL), the poster shape and
 * duplicate locales. Ownership of uploads needs the database (prepareStories).
 */
export function normalizeStoryInputs(
  stories: ProductStoryInputDto[],
): PreparedProductStory[] {
  if (stories.length > PRODUCT_STORY_MAX_PER_PRODUCT) {
    storyError(
      'STORY_LIMIT_EXCEEDED',
      `A product can have at most ${PRODUCT_STORY_MAX_PER_PRODUCT} customer stories.`,
      { max: PRODUCT_STORY_MAX_PER_PRODUCT },
    );
  }
  return stories.map((s, index) => {
    const name = normalizeStoryName(s.name);
    if (!name) {
      storyError('STORY_NAME_REQUIRED', 'Every story needs a name.', {
        index,
      });
    }

    let kind: ProductStoryKindValue;
    let url = String(s.url ?? '').trim();
    if (s.kind === 'image') {
      kind = 'IMAGE';
      if (!isOwnImageUrl(url)) {
        storyError('STORY_MEDIA_INVALID', 'The story image is not valid.', {
          index,
        });
      }
    } else if (s.kind === 'file') {
      kind = 'FILE';
      if (!PRODUCT_VIDEO_FILE_URL.test(url)) {
        storyError(
          'STORY_MEDIA_INVALID',
          'The story video is not a valid upload.',
          { index },
        );
      }
    } else {
      const parsed = parseExternalVideoUrl(url);
      if (!parsed || parsed.kind !== s.kind) {
        storyError(
          'STORY_URL_NOT_ALLOWED',
          'Only YouTube and Vimeo video links are allowed.',
          { index },
        );
      }
      kind = parsed.kind === 'youtube' ? 'YOUTUBE' : 'VIMEO';
      url = parsed.canonicalUrl;
    }

    // Image stories have no poster and no duration.
    const poster =
      kind !== 'IMAGE' && typeof s.poster_url === 'string'
        ? s.poster_url.trim()
        : '';
    if (
      poster &&
      (!PRODUCT_VIDEO_POSTER_URL.test(poster) || poster.includes('..'))
    ) {
      storyError('STORY_IMAGE_INVALID', 'The story cover image is not valid.', {
        index,
      });
    }

    const seen = new Set<string>();
    const translations: PreparedProductStoryTranslation[] = [];
    for (const t of s.translations ?? []) {
      if (seen.has(t.locale)) {
        storyError(
          'STORY_LOCALE_DUPLICATE',
          `A story has two texts for the language "${t.locale}".`,
          { index, locale: t.locale },
        );
      }
      seen.add(t.locale);
      const quote = normalizeStoryText(t.quote);
      const subtitle = normalizeStoryText(t.subtitle);
      // A locale with no text at all is not stored.
      if (!quote && !subtitle) continue;
      translations.push({
        locale: t.locale,
        quote,
        subtitle: subtitle || null,
      });
    }

    // An uploaded file was probed at upload time (<= max seconds); the
    // client-sent duration reaches the duration chip, so it is capped.
    const duration =
      kind === 'IMAGE' || s.duration_s == null
        ? null
        : kind === 'FILE'
          ? Math.min(s.duration_s, videoUploadConfig().maxSeconds + 1)
          : s.duration_s;

    return {
      ...(s.id ? { id: s.id } : {}),
      kind,
      url,
      poster_url: poster || null,
      duration_s: duration,
      width: s.width ?? null,
      height: s.height ?? null,
      name,
      rating: s.rating ?? null,
      verified: s.verified === true,
      sort_order: index,
      translations,
    };
  });
}
