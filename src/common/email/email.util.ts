/**
 * Canonical form of an email address for storage and lookup: trimmed and
 * lower-cased. `User.email` is unique and compared byte for byte, so every
 * path that stores or looks up an account (registration, login, password
 * reset, the Kustom guest-account path) must normalise with this first —
 * otherwise "Anna@Example.com" and "anna@example.com" become two accounts.
 *
 * Rows written before this helper existed may still carry mixed case; they
 * are lower-cased by a separate, one-off data migration (not part of the
 * application code). Until then lookups fall back to a case-insensitive
 * match for legacy rows.
 */
export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}
