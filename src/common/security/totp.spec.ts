import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  otpauthUrl,
  totpStep,
  verifyTotp,
} from './totp';

// RFC 6238 appendix B: SHA1 seed "12345678901234567890", 8-digit values.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('totp', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 vector at t=%i', (t, expected) => {
    expect(hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(expected);
  });

  it('round-trips base32', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(
      RFC_SECRET,
    );
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(
      RFC_SECRET,
    );
  });

  it('generates a 32-char base32 secret', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  describe('verifyTotp', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_111_111_111_000;
    const step = totpStep(now);
    const codeAt = (s: number) => hotp(RFC_SECRET, s);

    it('accepts the current step and returns it', () => {
      expect(verifyTotp(secret, codeAt(step), { nowMs: now })).toBe(step);
    });

    it('accepts ±1 step of drift but not ±2', () => {
      expect(verifyTotp(secret, codeAt(step - 1), { nowMs: now })).toBe(
        step - 1,
      );
      expect(verifyTotp(secret, codeAt(step + 1), { nowMs: now })).toBe(
        step + 1,
      );
      expect(verifyTotp(secret, codeAt(step - 2), { nowMs: now })).toBeNull();
      expect(verifyTotp(secret, codeAt(step + 2), { nowMs: now })).toBeNull();
    });

    it('refuses a replayed or older step', () => {
      expect(
        verifyTotp(secret, codeAt(step), { nowMs: now, lastUsedStep: step }),
      ).toBeNull();
      expect(
        verifyTotp(secret, codeAt(step - 1), {
          nowMs: now,
          lastUsedStep: step - 1,
        }),
      ).toBeNull();
      expect(
        verifyTotp(secret, codeAt(step), {
          nowMs: now,
          lastUsedStep: step - 1,
        }),
      ).toBe(step);
    });

    it('rejects malformed codes', () => {
      expect(verifyTotp(secret, '12345', { nowMs: now })).toBeNull();
      expect(verifyTotp(secret, 'abcdef', { nowMs: now })).toBeNull();
      expect(verifyTotp(secret, '', { nowMs: now })).toBeNull();
    });

    it('tolerates spaces inside the code', () => {
      const c = codeAt(step);
      expect(
        verifyTotp(secret, `${c.slice(0, 3)} ${c.slice(3)}`, { nowMs: now }),
      ).toBe(step);
    });
  });

  it('builds an otpauth URL authenticator apps understand', () => {
    const url = otpauthUrl('ABC', 'a@b.se', 'My Platform');
    expect(url.startsWith('otpauth://totp/My%20Platform%3Aa%40b.se?')).toBe(
      true,
    );
    expect(url).toContain('secret=ABC');
    expect(url).toContain('issuer=My+Platform');
  });

  describe('recovery codes', () => {
    it('generates 10 unique XXXXX-XXXXX codes', () => {
      const codes = generateRecoveryCodes();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const c of codes)
        expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    });

    it('hashes case/dash/space-insensitively', () => {
      expect(hashRecoveryCode('abcde-fghjk')).toBe(
        hashRecoveryCode('ABCDE FGHJK'),
      );
      expect(hashRecoveryCode('ABCDEFGHJK')).toBe(
        hashRecoveryCode('abcde-fghjk'),
      );
    });

    it('tells recovery codes from app codes', () => {
      expect(looksLikeRecoveryCode('abcde-fghjk')).toBe(true);
      expect(looksLikeRecoveryCode('123456')).toBe(false);
    });
  });
});
