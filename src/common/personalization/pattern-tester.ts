import { Logger } from '@nestjs/common';
import * as vm from 'vm';
import {
  charCount,
  compilePattern,
  PERSONALIZATION_LIMITS,
  type FieldDef,
  type PatternTester,
} from './rules';

/**
 * Server-side tester for merchant `pattern` rules (M4.0 ReDoS guard, no
 * `re2`). Save time refuses unsafe patterns (`isPatternSafe`); this is the
 * second line for anything that slips through and for patterns saved before
 * that check existed: every test runs inside one cached `vm` context with a
 * hard timeout, so a catastrophic pattern can block the event loop for at
 * most `PATTERN_TEST_TIMEOUT_MS`. A timeout fails closed (the value is
 * treated as not matching → `CUSTOM_FIELD_INVALID_FORMAT`) and logs a warning
 * with the field id.
 */

export const PATTERN_TEST_TIMEOUT_MS = 50;
/** Compiled patterns kept per process; the cache is reset when full. */
const MAX_CACHED_PATTERNS = 500;

interface TesterSandbox {
  __pattern: string;
  __input: string;
  __cache: Record<string, RegExp>;
}

let sandbox: TesterSandbox | null = null;
let context: vm.Context | null = null;
let cached = 0;
const script = new vm.Script(
  '(__cache[__pattern] || (__cache[__pattern] = new RegExp(__pattern))).test(__input)',
  { filename: 'personalization-pattern-tester.vm' },
);

function sandboxContext(): { box: TesterSandbox; ctx: vm.Context } {
  if (!sandbox || !context || cached >= MAX_CACHED_PATTERNS) {
    sandbox = {
      __pattern: '',
      __input: '',
      __cache: Object.create(null) as Record<string, RegExp>,
    };
    context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    cached = 0;
  }
  return { box: sandbox, ctx: context };
}

/** True when the error is the vm timeout. */
function isTimeout(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
  );
}

/**
 * Tests `input` against `pattern` with a hard timeout. Returns true on a
 * match; false on no match, on timeout and on inputs over
 * `maxPatternInputChars` (fail closed). A pattern that does not compile is
 * ignored (true), like the storefront always did.
 */
export function testPatternWithTimeout(
  pattern: string,
  input: string,
  opts: {
    timeoutMs?: number;
    onTimeout?: () => void;
  } = {},
): boolean {
  if (compilePattern(pattern) === null) return true;
  if (charCount(input) > PERSONALIZATION_LIMITS.maxPatternInputChars) {
    return false;
  }
  const { box, ctx } = sandboxContext();
  if (!(pattern in box.__cache)) cached++;
  box.__pattern = pattern;
  box.__input = input;
  try {
    return (
      script.runInContext(ctx, {
        timeout: opts.timeoutMs ?? PATTERN_TEST_TIMEOUT_MS,
        breakOnSigint: false,
      }) === true
    );
  } catch (err) {
    if (isTimeout(err)) {
      opts.onTimeout?.();
      return false;
    }
    return false;
  } finally {
    box.__input = '';
  }
}

const logger = new Logger('PersonalizationPatternTester');

/** Total vm time one evaluation (one line) may spend on merchant patterns. */
export const PATTERN_EVAL_BUDGET_MS = 150;
/** Timed-out patterns remembered per process; the map is reset when full. */
const MAX_TIMED_OUT_PATTERNS = 500;
/**
 * How long a timed-out pattern stays refused without running. Bounded, so a
 * timeout caused by a starved CPU (not by the pattern) does not refuse a
 * harmless pattern for the life of the process.
 */
export const TIMED_OUT_PATTERN_TTL_MS = 10 * 60_000;
const timedOutPatterns = new Map<string, number>();

/** True when `pattern` timed out recently (it then fails closed without running). */
export function isKnownSlowPattern(pattern: string): boolean {
  const until = timedOutPatterns.get(pattern);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  timedOutPatterns.delete(pattern);
  return false;
}

function rememberTimeout(pattern: string): void {
  if (timedOutPatterns.size >= MAX_TIMED_OUT_PATTERNS) timedOutPatterns.clear();
  timedOutPatterns.set(pattern, Date.now() + TIMED_OUT_PATTERN_TTL_MS);
}

/**
 * A `patternTester` for one evaluation: a pattern that timed out once is
 * refused without running again (fail closed), and the total vm time of
 * the evaluation is capped at `budgetMs` (each test gets at most what is
 * left; once spent, every further pattern fails closed).
 */
export function createServerPatternTester(
  budgetMs: number = PATTERN_EVAL_BUDGET_MS,
): PatternTester {
  let spent = 0;
  return (pattern: string, input: string, field: FieldDef): boolean => {
    if (compilePattern(pattern) === null) return true;
    if (isKnownSlowPattern(pattern)) return false;
    const remaining = budgetMs - spent;
    if (remaining <= 0) {
      logger.warn(
        `Pattern budget of ${budgetMs} ms spent; pattern of custom field ${field.id} refused`,
      );
      return false;
    }
    const timeoutMs = Math.max(
      1,
      Math.min(PATTERN_TEST_TIMEOUT_MS, Math.floor(remaining)),
    );
    const started = Date.now();
    try {
      return testPatternWithTimeout(pattern, input, {
        timeoutMs,
        onTimeout: () => {
          // Only a full-length timeout marks the pattern as slow; a test cut
          // short by the budget says nothing about the pattern itself.
          if (timeoutMs >= PATTERN_TEST_TIMEOUT_MS) rememberTimeout(pattern);
          logger.warn(
            `Pattern of custom field ${field.id} timed out after ${timeoutMs} ms (${charCount(input)} chars); value refused`,
          );
        },
      });
    } finally {
      spent += Date.now() - started;
    }
  };
}
