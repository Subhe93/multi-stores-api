/*
 * allowed_chars is parsed as data (M4.2 fixer B, ReDoS): a body can never
 * escape its character class, and the length cap runs before any regex.
 */
import {
  compileDesignAllowedChars,
  DESIGN_TEXT_RAW_MAX,
  TemplateSpecV1,
  TextElement,
  validateSpec,
  validateState,
} from '@multi-stores/core/designer';

const EVIL = 'b]|^(a+)+$|[b';

function specWith(allowed: string | undefined, maxLength = 20): TemplateSpecV1 {
  const el: TextElement = {
    id: 'name',
    type: 'text',
    x: 0,
    y: 0,
    w: 50,
    h: 10,
    rot: 0,
    z: 1,
    locked: false,
    label: { en: 'Name' },
    placeholder: { en: '' },
    default_text: '',
    font: { family: 'Inter', weight: 400, style: 'normal' },
    size: 10,
    color: '#000000',
    align: 'center',
    transform: 'none',
    fit: { mode: 'shrink', step: 0.5, min: 6, pad_ref_px: 8 },
    inset: 4,
    editable: true,
    required: false,
    max_length: maxLength,
    direction: 'auto',
    ...(allowed !== undefined ? { allowed_chars: allowed } : {}),
  } as TextElement;
  return {
    schema: 'designer.template/1',
    unit: 'mm',
    width: 100,
    height: 100,
    bleed_mm: 0,
    render: { preview_px_per_mm: 4, print_px_per_mm: 12, fit_ref_px_per_mm: 4 },
    fonts: [{ family: 'Inter', weight: 400, style: 'normal', asset_id: 'f1' }],
    surfaces: [
      { key: 'front', background: { color: '#ffffff' }, elements: [el] },
    ],
  } as unknown as TemplateSpecV1;
}

describe('compileDesignAllowedChars', () => {
  it('accepts literals, ranges, escapes and allowlisted properties', () => {
    for (const ok of [
      'A-Za-zÅÄÖåäö \\-',
      'a-zA-Z❤\\s',
      '\\p{L}\\p{Nd} ',
      '\\p{Script=Arabic}0-9',
      '\\u0041-\\u005A',
      '\\u{1F600}-\\u{1F64F}',
      '\\x41',
      '.,$/^',
      '-a',
      'a-',
    ]) {
      expect({ ok, re: compileDesignAllowedChars(ok) !== null }).toEqual({
        ok,
        re: true,
      });
    }
    const re = compileDesignAllowedChars('A-Z\\-')!;
    expect(re.test('AB-C')).toBe(true);
    expect(re.test('ABc')).toBe(false);
    // Literal metacharacters keep their literal meaning.
    expect(compileDesignAllowedChars('.$')!.test('.$.')).toBe(true);
    expect(compileDesignAllowedChars('.$')!.test('x')).toBe(false);
    // A leading ^ negates, like the M4.0 class body.
    expect(compileDesignAllowedChars('^0-9')!.test('abc')).toBe(true);
    expect(compileDesignAllowedChars('^0-9')!.test('a1')).toBe(false);
  });

  it('refuses bare metacharacters, backrefs, unknown escapes and bad ranges', () => {
    for (const bad of [
      EVIL,
      ']',
      '[',
      'a|b',
      '(a)',
      'a*',
      'a+',
      'a?',
      'a{2}',
      '\\1',
      '\\k<x>',
      '\\b',
      '\\c',
      '\\p{Any}',
      '\\p{L',
      '\\d-z',
      'z-a',
      '^',
      '',
      'a'.repeat(201),
    ]) {
      expect({ bad, re: compileDesignAllowedChars(bad) }).toEqual({
        bad,
        re: null,
      });
    }
  });
});

describe('allowed_chars in validateSpec / validateState', () => {
  it('validateSpec rejects the evil body', () => {
    const r = validateSpec(specWith(EVIL));
    expect(r.errors).toEqual(
      expect.arrayContaining([
        { path: 'surfaces[0].elements[0].allowed_chars', rule: 'regex' },
      ]),
    );
    expect(validateSpec(specWith('A-Za-z ')).ok).toBe(true);
  });

  it('validateState stays fast and fails closed on the evil body', () => {
    const spec = specWith(EVIL, 1000);
    const t0 = Date.now();
    const r = validateState(spec, {
      texts: { name: 'a'.repeat(40) + '!' },
    });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.errors).toEqual([{ element_id: 'name', rule: 'chars' }]);
  });

  it('caps the raw length before normalizing or matching', () => {
    const spec = specWith('a-z', 0);
    const huge = 'a'.repeat(DESIGN_TEXT_RAW_MAX + 1);
    const r = validateState(spec, { texts: { name: huge } });
    expect(r.errors).toEqual([{ element_id: 'name', rule: 'max_length' }]);
    expect(r.normalized.texts.name).toBeUndefined();
  });

  it('a too-long text reports max_length only', () => {
    const r = validateState(specWith('a-z', 3), { texts: { name: 'ABCD' } });
    expect(r.errors).toEqual([{ element_id: 'name', rule: 'max_length' }]);
  });
});
