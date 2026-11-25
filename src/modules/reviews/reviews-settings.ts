// Settings of the `reviews` store app (M171), kept in StoreApp.settings. Two
// readers, like the other apps: a lenient parse for the runtime (odd values
// fall back to the default, never throws) and a strict validation for the
// dashboard write (PUT /stores/my/apps/reviews -> STORE_APP_SETTINGS_INVALID).

export interface ReviewsSettings {
  /** Publish a submitted review at once instead of waiting for moderation. */
  auto_publish: boolean;
}

export const DEFAULT_REVIEWS_SETTINGS: Readonly<ReviewsSettings> =
  Object.freeze({ auto_publish: false });

const KNOWN_KEYS = new Set<string>(['auto_publish']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Lenient read: anything but `auto_publish: true` is moderation first. */
export function normalizeReviewsSettings(raw: unknown): ReviewsSettings {
  const r = isRecord(raw) ? raw : {};
  return { auto_publish: r.auto_publish === true };
}

/** Strict validation of a settings write: only `auto_publish`, a boolean. */
export function validateReviewsSettings(raw: unknown): {
  ok: boolean;
  errors: string[];
} {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['settings must be an object.'] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`Unknown setting "${key}".`);
  }
  if ('auto_publish' in raw && typeof raw.auto_publish !== 'boolean') {
    errors.push('auto_publish must be true or false.');
  }
  return { ok: errors.length === 0, errors };
}
