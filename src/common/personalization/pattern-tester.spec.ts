import { Logger } from '@nestjs/common';
import {
  PATTERN_TEST_TIMEOUT_MS,
  serverPatternTester,
  testPatternWithTimeout,
} from './pattern-tester';
import {
  isPatternSafe,
  patternProblem,
  validatePersonalization,
} from './rules';

// M4.0 ReDoS guard: the server runs merchant patterns under a hard timeout
// and fails closed; save time refuses the classic catastrophic shapes.

const EVIL = '^([A-Za-z]+ ?)+$';
// 40 characters that almost match: exponential backtracking without a guard.
const EVIL_INPUT = 'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!';

describe('server pattern tester', () => {
  it('matches and refuses like a plain RegExp for normal patterns', () => {
    expect(testPatternWithTimeout('^[A-Z]+$', 'ANNA')).toBe(true);
    expect(testPatternWithTimeout('^[A-Z]+$', 'Anna')).toBe(false);
    // A pattern that does not compile is ignored, as the storefront did.
    expect(testPatternWithTimeout('^(abc$', 'x')).toBe(true);
  });

  it('the evil pattern with a 40-char input returns within ~100 ms and fails closed', () => {
    expect(EVIL_INPUT).toHaveLength(40);
    const onTimeout = jest.fn();
    const started = Date.now();
    const ok = testPatternWithTimeout(EVIL, EVIL_INPUT, { onTimeout });
    const elapsed = Date.now() - started;
    expect(ok).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(PATTERN_TEST_TIMEOUT_MS + 100);
  });

  it('the cached context still works after a timeout', () => {
    testPatternWithTimeout(EVIL, EVIL_INPUT);
    expect(testPatternWithTimeout(EVIL, 'Anna Maria')).toBe(true);
    expect(testPatternWithTimeout('^\\d+$', '123')).toBe(true);
  });

  it('refuses inputs over 500 code points without running the pattern', () => {
    expect(testPatternWithTimeout('^a+$', 'a'.repeat(500))).toBe(true);
    expect(testPatternWithTimeout('^a+$', 'a'.repeat(501))).toBe(false);
  });

  it('validatePersonalization with the server tester: INVALID_FORMAT and a warning naming the field', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const started = Date.now();
    const res = validatePersonalization({
      fields: [
        {
          id: 'field-evil',
          name: 'name_1',
          type: 'TEXT',
          is_required: true,
          validation_rules: { pattern: EVIL },
        },
      ],
      values: { 'field-evil': EVIL_INPUT },
      patternTester: serverPatternTester,
    });
    expect(Date.now() - started).toBeLessThan(PATTERN_TEST_TIMEOUT_MS + 100);
    expect(res.issues).toEqual([
      {
        code: 'CUSTOM_FIELD_INVALID_FORMAT',
        field_id: 'field-evil',
        field_name: 'name_1',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('field-evil'));
    warn.mockRestore();
  });

  it('save time refuses the evil pattern as unsafe', () => {
    expect(isPatternSafe(EVIL)).toBe(false);
    expect(patternProblem(EVIL)).toBe('unsafe');
    expect(patternProblem('^[A-Za-z ]+$')).toBeNull();
  });
});
