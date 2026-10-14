/**
 * Embedded fonts for invoice PDFs.
 *
 * Source: the `@fontsource/noto-sans` and `@fontsource/noto-sans-arabic` npm
 * packages (Google Noto fonts, SIL Open Font License 1.1, licence text in each
 * package's LICENSE file). Resolving them through node_modules works the same
 * from `src/` (ts-node / jest) and from `dist/` (nest build does not copy
 * assets), so nothing has to be vendored.
 *
 * The Latin family covers Swedish, German, French and Turkish (latin +
 * latin-ext subsets); the Arabic family covers Arabic script. The CSS stack
 * lists Latin first, so Arabic glyphs fall through to Noto Sans Arabic per
 * character, which also keeps digits and Latin words in Noto Sans on Arabic
 * invoices. The renderer blocks the network, so fonts must be inlined.
 */
import { readFileSync } from 'fs';

export const INVOICE_FONT_STACK =
  "'Noto Sans', 'Noto Sans Arabic', 'Segoe UI', Arial, sans-serif";

const FONT_FILES: { family: string; weight: number; spec: string }[] = [
  {
    family: 'Noto Sans',
    weight: 400,
    spec: '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2',
  },
  {
    family: 'Noto Sans',
    weight: 400,
    spec: '@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff2',
  },
  {
    family: 'Noto Sans',
    weight: 700,
    spec: '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff2',
  },
  {
    family: 'Noto Sans',
    weight: 700,
    spec: '@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff2',
  },
  {
    family: 'Noto Sans Arabic',
    weight: 400,
    spec: '@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff2',
  },
  {
    family: 'Noto Sans Arabic',
    weight: 700,
    spec: '@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff2',
  },
];

// Unicode ranges as published by fontsource for each subset; two faces of
// the same family/weight must not overlap or the browser picks one at random.
const RANGES: Record<string, string> = {
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};

function subsetOf(spec: string): string | null {
  if (spec.includes('-latin-ext-')) return 'latin-ext';
  if (spec.includes('-latin-')) return 'latin';
  return null;
}

let cached: string | null = null;

/** Builds (once) the base64 `@font-face` CSS for the invoice fonts. */
export function getInvoiceFontCss(): string {
  if (cached !== null) return cached;
  const faces: string[] = [];
  for (const f of FONT_FILES) {
    let data: string;
    try {
      data = readFileSync(require.resolve(f.spec)).toString('base64');
    } catch {
      // Missing package: the PDF still renders with system fonts.
      continue;
    }
    const subset = subsetOf(f.spec);
    const range = subset ? `unicode-range:${RANGES[subset]};` : '';
    faces.push(
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};` +
        `src:url(data:font/woff2;base64,${data}) format('woff2');${range}}`,
    );
  }
  cached = faces.join('\n');
  return cached;
}
