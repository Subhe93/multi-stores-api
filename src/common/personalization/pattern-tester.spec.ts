import { Logger } from '@nestjs/common';
import {
  createServerPatternTester,
  PATTERN_TEST_TIMEOUT_MS,
  testPatternWithTimeout,
} from './pattern-tester';
import {
  isPatternSafe,
  patternProblem,
  validatePersonalization,
} from '@multi-stores/core/personalization/rules';

// M4.0 ReDoS guard: the server runs merchant patterns under a hard timeout
// and fails closed; save time refuses the classic catastrophic shapes.

// Accepted at save time since M5 A10 (several quantified atoms); still
// catastrophic at run time, which is what the vm timeout is for.
const EVIL = '^([A-Za-z]+ ?)+$';
// 40 characters that almost match: exponential backtracking without a guard.
const EVIL_INPUT = 'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!';
// Refused at save time: a repeated group whose body is one quantified atom.
const NESTED_PLUS = '^(a+)+$';

describe('server pattern tester', () => {
  it('matches and refuses like a plain RegExp for normal patterns', () => {
    expect(testPatternWithTimeout('^[A-Z]+$', 'ANNA')).toBe(true);
    expect(testPatternWithTimeout('^[A-Z]+$', 'Anna')).toBe(false);
    // A pattern that does not compile is ignored, as the storefront did.
    expect(testPatternWithTimeout('^(abc$', 'x')).toBe(true);
  });

  it('the evil pattern with a 40-char input is cut by the vm timeout and fails closed', () => {
    expect(EVIL_INPUT).toHaveLength(40);
    // The timeout firing is the observable (no wall-clock assertion): the
    // vm cuts the match at PATTERN_TEST_TIMEOUT_MS and reports it here.
    const onTimeout = jest.fn();
    const ok = testPatternWithTimeout(EVIL, EVIL_INPUT, { onTimeout });
    expect(ok).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
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
      patternTester: createServerPatternTester(),
    });
    // The vm timeout fired (observable through the warning), so the test
    // was cut at PATTERN_TEST_TIMEOUT_MS instead of backtracking for ages.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`timed out after ${PATTERN_TEST_TIMEOUT_MS} ms`),
    );
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

  it('save time refuses a nested quantifier as unsafe; A10 shapes pass', () => {
    expect(isPatternSafe(NESTED_PLUS)).toBe(false);
    expect(patternProblem(NESTED_PLUS)).toBe('unsafe');
    expect(patternProblem('^[A-Za-z ]+$')).toBeNull();
    // M5 A10: accepted at save time, guarded by the vm timeout at run time.
    expect(patternProblem(EVIL)).toBeNull();
    expect(patternProblem('^([A-Z]|[a-z])+$')).toBeNull();
    expect(patternProblem('^(?:[a-z]+\\s?)+$')).toBeNull();
  });
});
