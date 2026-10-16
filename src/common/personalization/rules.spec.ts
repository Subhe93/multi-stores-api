import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  charCount,
  isFileRefPath,
  isValidAllowedChars,
  isValidPattern,
  compileAllowedChars,
  lineKey,
  normalizeFieldValues,
  patternProblem,
  readLinkedValidation,
  validatePersonalization,
  type FieldDef,
} from './rules';

// Runs every shared vector against the api mirror (M4.0 K6) and checks that
// the mirror is still a byte copy of the shared source when the shared repo
// is checked out next to this one.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
type Json = any;

const VECTORS_PATH = join(__dirname, 'personalization.vectors.json');
const vectors: Record<string, Json> = JSON.parse(
  readFileSync(VECTORS_PATH, 'utf8'),
);

const SHARED_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'multi-stores-shared',
  'src',
  'personalization',
);

/** Lines of a text file with CRLF folded to LF (git autocrlf on Windows). */
function lf(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** The mirror minus its 3-line header. */
function mirrorBody(): string {
  return lf(join(__dirname, 'rules.ts')).split('\n').slice(3).join('\n');
}

describe('personalization rules mirror parity', () => {
  const sharedAvailable = existsSync(join(SHARED_DIR, 'rules.ts'));

  it('carries the mirror header', () => {
    const head = lf(join(__dirname, 'rules.ts')).split('\n').slice(0, 3);
    expect(head[0]).toBe('/* eslint-disable */');
    expect(head[1]).toContain('MIRROR');
    expect(head[1]).toContain(
      'multi-stores-shared/src/personalization/rules.ts',
    );
  });

  (sharedAvailable ? it : it.skip)(
    'rules.ts body equals the shared source (sha256)',
    () => {
      expect(sha256(mirrorBody())).toBe(
        sha256(lf(join(SHARED_DIR, 'rules.ts'))),
      );
    },
  );

  (sharedAvailable ? it : it.skip)(
    'vectors are a byte copy of the shared file (sha256)',
    () => {
      expect(sha256(lf(VECTORS_PATH))).toBe(
        sha256(lf(join(SHARED_DIR, 'personalization.vectors.json'))),
      );
    },
  );
});

describe('personalization vectors', () => {
  it('has the expected version', () => {
    expect(vectors.version).toBe(1);
  });

  describe('charCount', () => {
    it.each(vectors.charCount.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        expect(charCount(c.input)).toBe(c.expected);
      },
    );
  });

  describe('normalizeFieldValues', () => {
    it.each(vectors.normalize.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        expect(normalizeFieldValues(c.input)).toEqual(c.expected);
      },
    );
  });

  describe('lineKey', () => {
    it.each(vectors.lineKey.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        const a = lineKey(c.a, c.aDesign);
        if (c.expectedA !== undefined) expect(a).toBe(c.expectedA);
        if (c.equal !== undefined) {
          const b = lineKey(c.b, c.bDesign);
          if (c.equal) expect(a).toBe(b);
          else expect(a).not.toBe(b);
        }
      },
    );
  });

  describe('allowed_chars', () => {
    it.each(vectors.allowedChars.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        expect(isValidAllowedChars(c.body)).toBe(c.valid);
        const re = compileAllowedChars(c.body);
        for (const s of c.samples as { value: string; ok: boolean }[]) {
          // Same test the validator runs: after removing U+FE0E/U+FE0F.
          const v = s.value.replace(/[\uFE0E\uFE0F]/g, '');
          expect(re?.test(v)).toBe(s.ok);
        }
      },
    );
  });

  describe('pattern', () => {
    it.each(vectors.pattern.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        expect(isValidPattern(c.pattern)).toBe(c.valid);
        if (c.reason !== undefined) {
          expect(patternProblem(c.pattern)).toBe(c.reason);
        }
      },
    );
  });

  describe('linked_validation', () => {
    it.each(vectors.linkedValidation.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        expect(readLinkedValidation(c.raw)).toEqual(c.expected);
      },
    );
  });

  describe('file references', () => {
    it.each(vectors.fileRef.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        expect(isFileRefPath(c.url)).toBe(c.ok);
      },
    );
  });

  describe('validatePersonalization', () => {
    it.each(vectors.validate.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        const res = validatePersonalization({
          fields: c.fields as FieldDef[],
          values: c.values,
          prefilled: c.prefilled,
        });
        expect(res.ok).toBe(c.expected.ok);
        expect(res.issues).toEqual(c.expected.issues);
        if (c.expected.values !== undefined) {
          expect(res.values).toEqual(c.expected.values);
        }
      },
    );
  });

  describe('generated payload limits', () => {
    it.each(vectors.generated.map((c: Json) => [c.name, c]))(
      '%s',
      (_n, c: Json) => {
        const value = (c.repeat as string).repeat(c.count as number);
        const res = validatePersonalization({
          fields: [c.field as FieldDef],
          values: { [c.field.id]: value },
        });
        if (c.expectedCode === null) {
          expect(res.ok).toBe(true);
        } else {
          expect(res.issues[0]?.code).toBe(c.expectedCode);
        }
      },
    );
  });
});
