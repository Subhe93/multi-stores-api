import { BadRequestException } from '@nestjs/common';
import { isReviewLocale } from './market.types';

export const STORE_LANGUAGE_IN_REVIEW = 'STORE_LANGUAGE_IN_REVIEW';

/**
 * A locale in review (REVIEW_LOCALES) is served only under its URL prefix and
 * hidden from the switcher. A store primary / market default locale has no
 * prefix, so it could not be hidden: reject it with 400. The value is
 * compared trimmed and lower-cased, the way the markets normalisation stores
 * it. Null / undefined (field not sent) passes.
 */
export function assertNotReviewPrimaryLocale(
  locale: string | null | undefined,
): void {
  const code = locale?.trim().toLowerCase();
  if (code && isReviewLocale(code)) {
    throw new BadRequestException({
      code: STORE_LANGUAGE_IN_REVIEW,
      message: `Language "${code}" is still in review: it can only be added as a secondary language`,
    });
  }
}
