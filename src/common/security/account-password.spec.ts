import {
  ACCOUNT_PASSWORD_LENGTH,
  generateAccountPassword,
} from './account-password';

describe('generateAccountPassword', () => {
  it('returns 16 characters by default', () => {
    expect(generateAccountPassword()).toHaveLength(ACCOUNT_PASSWORD_LENGTH);
    expect(ACCOUNT_PASSWORD_LENGTH).toBe(16);
  });

  it('always contains a lower-case letter, an upper-case letter and a digit', () => {
    for (let i = 0; i < 500; i++) {
      const pw = generateAccountPassword();
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it('never uses ambiguous characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateAccountPassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it('only uses the URL- and copy-safe alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateAccountPassword()).toMatch(/^[A-Za-z2-9]+$/);
    }
  });

  it('produces distinct values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateAccountPassword());
    expect(seen.size).toBe(1000);
  });

  it('honours a custom length but never drops below the three classes', () => {
    expect(generateAccountPassword(24)).toHaveLength(24);
    expect(generateAccountPassword(1)).toHaveLength(3);
  });
});
