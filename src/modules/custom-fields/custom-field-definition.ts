import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  charCount,
  isPlainObject,
  isValidAllowedChars,
  patternProblem,
  PERSONALIZATION_LIMITS,
} from '../../common/personalization/rules';

/**
 * Save-time checks of a field definition's merchant rules (M4.0 §3.2, K3).
 *
 * - `validation_rules`: `{min_length?, max_length?, pattern?, allowed_chars?,
 *   min_checked?, max_checked?}`; `min_checked`/`max_checked` (CHECKBOX_GROUP,
 *   M4.1 C17) are integers 0–50; length bounds are integers 0–5000 (NUMBER fields reuse them as value bounds,
 *   W12), `pattern` and `allowed_chars` must compile under the storefront's
 *   rules, and `pattern` must pass the ReDoS heuristic (`isPatternSafe`,
 *   `params.reason`: invalid | too_long | unsafe). Unknown keys are refused.
 * - `linked_validation`: `{type:'equal_length', target, fill_char?}` or
 *   `{type:'max_combined', target, max}`; `target` is the sibling field's
 *   name (legacy `target_field_id` is accepted and stored as `target`);
 *   the service checks that it names (or, legacy, is the id of) a sibling.
 *   `fill_char` is exactly one character (`charCount` = 1).
 * - `null` clears a rule (stored as SQL NULL); `undefined` leaves it alone.
 */

export const CUSTOM_FIELD_INVALID_RULES = 'CUSTOM_FIELD_INVALID_RULES';
export const CUSTOM_FIELD_INVALID_PATTERN = 'CUSTOM_FIELD_INVALID_PATTERN';
export const CUSTOM_FIELD_INVALID_ALLOWED_CHARS =
  'CUSTOM_FIELD_INVALID_ALLOWED_CHARS';
export const CUSTOM_FIELD_INVALID_LINK = 'CUSTOM_FIELD_INVALID_LINK';
export const CUSTOM_FIELD_NAME_TAKEN = 'CUSTOM_FIELD_NAME_TAKEN';
export const CUSTOM_FIELD_IN_USE = 'CUSTOM_FIELD_IN_USE';

const RULE_KEYS = new Set([
  'min_length',
  'max_length',
  'pattern',
  'allowed_chars',
  'min_checked',
  'max_checked',
]);
const MAX_BOUND = 5000;
const MAX_CHECKED_BOUND = 50;
const MAX_TARGET_LENGTH = 64;
const MAX_COMBINED = 1000;

type JsonInput = Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;

function fail(
  code: string,
  message: string,
  params?: Record<string, string | number>,
): never {
  throw new BadRequestException({ code, message, ...(params && { params }) });
}

/** Integer bound, null/'' when absent, NaN when malformed. */
function readBound(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return parseInt(v, 10);
  return NaN;
}

/** Sanitizes `validation_rules` for storage. */
export function sanitizeValidationRules(raw: unknown): JsonInput {
  if (raw === undefined) return undefined;
  if (raw === null) return Prisma.DbNull;
  if (!isPlainObject(raw)) {
    fail(CUSTOM_FIELD_INVALID_RULES, 'validation_rules must be an object');
  }
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!RULE_KEYS.has(key)) {
      fail(CUSTOM_FIELD_INVALID_RULES, `Unknown validation rule "${key}"`);
    }
    if (key === 'min_length' || key === 'max_length') {
      const n = readBound(value);
      if (n === null) continue;
      if (!Number.isInteger(n) || n < 0 || n > MAX_BOUND) {
        fail(
          CUSTOM_FIELD_INVALID_RULES,
          `${key} must be an integer between 0 and ${MAX_BOUND}`,
        );
      }
      out[key] = n;
      continue;
    }
    if (key === 'min_checked' || key === 'max_checked') {
      const n = readBound(value);
      if (n === null) continue;
      if (!Number.isInteger(n) || n < 0 || n > MAX_CHECKED_BOUND) {
        fail(
          CUSTOM_FIELD_INVALID_RULES,
          `${key} must be an integer between 0 and ${MAX_CHECKED_BOUND}`,
        );
      }
      out[key] = n;
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') {
      fail(CUSTOM_FIELD_INVALID_RULES, `${key} must be a string`);
    }
    const problem = key === 'pattern' ? patternProblem(value) : null;
    if (problem === 'unsafe') {
      fail(
        CUSTOM_FIELD_INVALID_PATTERN,
        'pattern is too complex to run safely (nested or overlapping repeats, backreferences or lookarounds); please simplify it',
        { reason: 'unsafe' },
      );
    }
    if (problem) {
      fail(
        CUSTOM_FIELD_INVALID_PATTERN,
        `pattern must be a valid regular expression of at most ${PERSONALIZATION_LIMITS.maxPatternLength} characters`,
        { reason: problem, max: PERSONALIZATION_LIMITS.maxPatternLength },
      );
    }
    if (key === 'allowed_chars' && !isValidAllowedChars(value)) {
      fail(
        CUSTOM_FIELD_INVALID_ALLOWED_CHARS,
        `allowed_chars must be a valid character class body of at most ${PERSONALIZATION_LIMITS.maxAllowedCharsLength} characters`,
      );
    }
    out[key] = value;
  }
  if (
    typeof out.min_length === 'number' &&
    typeof out.max_length === 'number' &&
    out.min_length > out.max_length
  ) {
    fail(CUSTOM_FIELD_INVALID_RULES, 'min_length is larger than max_length');
  }
  if (
    typeof out.min_checked === 'number' &&
    typeof out.max_checked === 'number' &&
    out.min_checked > out.max_checked
  ) {
    fail(CUSTOM_FIELD_INVALID_RULES, 'min_checked is larger than max_checked');
  }
  return Object.keys(out).length > 0 ? out : Prisma.DbNull;
}

/**
 * Sanitizes `linked_validation` for storage. `self` is the field's own name
 * and id (a field can't be linked to itself).
 */
export function sanitizeLinkedValidation(
  raw: unknown,
  self: { name?: string | null; id?: string | null },
): JsonInput {
  if (raw === undefined) return undefined;
  if (raw === null) return Prisma.DbNull;
  if (!isPlainObject(raw)) {
    fail(CUSTOM_FIELD_INVALID_LINK, 'linked_validation must be an object');
  }
  const type = raw.type;
  if (type !== 'equal_length' && type !== 'max_combined') {
    fail(
      CUSTOM_FIELD_INVALID_LINK,
      'linked_validation.type must be equal_length or max_combined',
    );
  }
  const rawTarget =
    typeof raw.target === 'string' && raw.target.trim() !== ''
      ? raw.target
      : raw.target_field_id;
  const target = typeof rawTarget === 'string' ? rawTarget.trim() : '';
  if (!target || target.length > MAX_TARGET_LENGTH) {
    fail(
      CUSTOM_FIELD_INVALID_LINK,
      'linked_validation.target must be the name of another field',
    );
  }
  if (target === self.name?.trim() || (self.id && target === self.id)) {
    fail(CUSTOM_FIELD_INVALID_LINK, 'A field cannot be linked to itself');
  }
  if (type === 'equal_length') {
    const fill = raw.fill_char;
    if (fill === undefined || fill === null || fill === '') {
      return { type, target };
    }
    if (typeof fill !== 'string' || charCount(fill) !== 1) {
      fail(
        CUSTOM_FIELD_INVALID_LINK,
        'fill_char must be exactly one character',
      );
    }
    return { type, target, fill_char: fill };
  }
  const max = readBound(raw.max);
  if (max === null || !Number.isInteger(max) || max < 1 || max > MAX_COMBINED) {
    fail(
      CUSTOM_FIELD_INVALID_LINK,
      `max_combined needs a max between 1 and ${MAX_COMBINED}`,
    );
  }
  return { type, target, max };
}

/** `options`: `null` clears (SQL NULL); anything else is stored as sent. */
export function sanitizeOptions(raw: unknown): JsonInput {
  if (raw === undefined) return undefined;
  if (raw === null) return Prisma.DbNull;
  return raw as Prisma.InputJsonValue;
}
