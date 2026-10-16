import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseTsv,
  parseTsvStream,
  TsvParseError,
  TsvStreamParser,
  unescapeWpCliField,
} from './tsv';
import { BUNDLE_TABLES } from './bundle-schema';

const FIXTURES = join(__dirname, '__fixtures__', 'namez-slice');

async function* toAsync(it: Iterable<string>): AsyncIterable<string> {
  for (const chunk of it) {
    await Promise.resolve();
    yield chunk;
  }
}

describe('unescapeWpCliField', () => {
  it('decodes the WP-CLI escapes and keeps everything else', () => {
    expect(unescapeWpCliField('a\\nb\\tc\\\\d')).toBe('a\nb\tc\\d');
    expect(unescapeWpCliField('nul\\0x')).toBe('nul\0x');
    expect(unescapeWpCliField('unknown \\q escape')).toBe('unknown \\q escape');
    expect(unescapeWpCliField('trailing \\')).toBe('trailing \\');
    expect(unescapeWpCliField('\\\\n is a backslash then n')).toBe(
      '\\n is a backslash then n',
    );
  });

  it('maps the bare NULL token to null', () => {
    expect(unescapeWpCliField('NULL')).toBeNull();
    expect(unescapeWpCliField('NULLX')).toBe('NULLX');
    expect(unescapeWpCliField('NULL', false)).toBe('NULL');
  });
});

describe('parseTsv', () => {
  const cols = ['meta_id', 'post_id', 'meta_key', 'meta_value'];

  it('parses fixed columns, escapes, NULL and a trailing newline', () => {
    const text = '1\t10\tk\tline1\\nline2\n2\t10\t_stock\tNULL\n';
    const r = parseTsv(text, { columns: cols });
    expect(r.rows).toEqual([
      {
        meta_id: '1',
        post_id: '10',
        meta_key: 'k',
        meta_value: 'line1\nline2',
      },
      { meta_id: '2', post_id: '10', meta_key: '_stock', meta_value: null },
    ]);
    expect(r.issues).toEqual([]);
  });

  it('keeps a raw CR inside a value (mysql does not escape CR)', () => {
    const r = parseTsv('1\t10\tk\ta\r\\nb\n', { columns: cols });
    expect(r.rows[0].meta_value).toBe('a\r\nb');
  });

  it('auto-detects CRLF files from the first line', () => {
    const r = parseTsv('1\t10\tk\tv\r\n2\t10\tk2\tw\r\n', { columns: cols });
    expect(r.rows.map((x) => x.meta_value)).toEqual(['v', 'w']);
  });

  it('strips a BOM and skips empty lines', () => {
    const r = parseTsv('\uFEFF1\t10\tk\tv\n\n\n2\t11\tk\tw', { columns: cols });
    expect(r.rows.map((x) => x.meta_id)).toEqual(['1', '2']);
  });

  it('re-joins an unescaped line break in the last field (continuation lines)', () => {
    const r = parseTsv('1\t10\tk\tfirst\nsecond\nthird\n2\t10\tk\tv\n', {
      columns: cols,
    });
    expect(r.rows.map((x) => x.meta_value)).toEqual([
      'first\nsecond\nthird',
      'v',
    ]);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'W_TSV_ROW_JOINED', line: 1 }),
    ]);
  });

  it('re-joins an unescaped line break in a middle field (forward join)', () => {
    const posts = ['ID', 'post_title', 'post_type'];
    const r = parseTsv('7\tTwo\nlines\tproduct\n8\tOne\tproduct\n', {
      columns: posts,
    });
    expect(r.rows).toEqual([
      { ID: '7', post_title: 'Two\nlines', post_type: 'product' },
      { ID: '8', post_title: 'One', post_type: 'product' },
    ]);
    expect(r.issues.map((i) => i.code)).toEqual(['W_TSV_ROW_JOINED']);
  });

  it('treats a short line that looks like a row start as a new row, not a continuation', () => {
    const r = parseTsv('1\t10\tk\tv\n2\t10\n', { columns: cols });
    expect(r.rows.map((x) => x.meta_id)).toEqual(['1']);
    expect(r.issues.map((i) => i.code)).toEqual(['W_TSV_ROW_INVALID']);
  });

  it('drops rows with too many fields and reports them', () => {
    const r = parseTsv('1\t10\tk\tv\textra\n2\t10\tk\tw\n', { columns: cols });
    expect(r.rows.map((x) => x.meta_id)).toEqual(['2']);
    expect(r.issues[0]).toMatchObject({ code: 'W_TSV_ROW_INVALID', line: 1 });
  });

  it('reports an incomplete last row', () => {
    const r = parseTsv('1\t10\tk\n', { columns: cols });
    expect(r.rows).toEqual([]);
    expect(r.issues[0].code).toBe('W_TSV_ROW_INVALID');
  });

  it('accepts optional trailing columns (terms.term_order)', () => {
    const spec = BUNDLE_TABLES.terms;
    const r = parseTsv('1\tA\ta\t0\n2\tB\tb\t0\t5\n', {
      columns: spec.columns,
      minColumns: spec.minColumns,
    });
    expect(r.rows).toEqual([
      { term_id: '1', name: 'A', slug: 'a', term_group: '0', term_order: null },
      { term_id: '2', name: 'B', slug: 'b', term_group: '0', term_order: '5' },
    ]);
  });

  it('reads a header row (bundle v1) and checks required columns', () => {
    const r = parseTsv('option_name\toption_value\nhome\thttps://x.se\n', {
      header: true,
      columns: ['option_name', 'option_value'],
    });
    expect(r.columns).toEqual(['option_name', 'option_value']);
    expect(r.rows).toEqual([
      { option_name: 'home', option_value: 'https://x.se' },
    ]);
    expect(() =>
      parseTsv('a\tb\n1\t2\n', {
        header: true,
        columns: ['option_name', 'option_value'],
      }),
    ).toThrow(TsvParseError);
  });

  it('enforces the per-value size limit', () => {
    expect(() =>
      parseTsv(`1\t10\tk\t${'x'.repeat(100)}\n`, {
        columns: cols,
        maxValueBytes: 50,
      }),
    ).toThrow(/exceeds 50 bytes/);
  });

  it('is not vulnerable to prototype pollution through column names', () => {
    const r = parseTsv('__proto__\tb\n{"x":1}\t2\n', { header: true });
    expect(Object.getPrototypeOf(r.rows[0])).toBe(Object.prototype);
    expect(Object.keys(r.rows[0])).toEqual(['__proto__', 'b']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('gives the same rows when fed in arbitrary chunks', async () => {
    const text = readFileSync(join(FIXTURES, 'postmeta.tsv'), 'utf8');
    const whole = parseTsv(text, { columns: cols });
    const chunks = function* () {
      for (let i = 0; i < text.length; i += 997) yield text.slice(i, i + 997);
    };
    const streamed = await parseTsvStream(toAsync(chunks()), {
      columns: cols,
    });
    expect(streamed.rows).toEqual(whole.rows);
    expect(whole.issues).toEqual([]);
  });

  it('parses every real fixture file with the legacy column orders and no issues', () => {
    for (const spec of Object.values(BUNDLE_TABLES)) {
      if ('positional' in spec && spec.positional) continue;
      let text: string;
      try {
        text = readFileSync(join(FIXTURES, spec.file), 'utf8');
      } catch {
        continue; // v1-only tables are not in the legacy slice
      }
      const r = parseTsv(text, {
        columns: spec.columns,
        minColumns: 'minColumns' in spec ? spec.minColumns : undefined,
      });
      expect({ file: spec.file, issues: r.issues }).toEqual({
        file: spec.file,
        issues: [],
      });
      expect(r.rows.length).toBe(
        text.split('\n').filter((l) => l !== '').length,
      );
    }
  });

  it('decodes real escaped content: post_content with \\n and raw CR, ppom JSON with \\\\u escapes', () => {
    const posts = parseTsv(readFileSync(join(FIXTURES, 'posts.tsv'), 'utf8'), {
      columns: BUNDLE_TABLES.posts.columns,
    });
    const p2229 = posts.rows.find((r) => r.ID === '2229')!;
    expect(p2229.post_type).toBe('product');
    expect(p2229.post_content).toContain('\n');
    expect(p2229.post_content).not.toContain('\\n');
    const ppomText = readFileSync(join(FIXTURES, 'ppom_meta.tsv'), 'utf8');
    const parser = new TsvStreamParser({
      columns: Array.from({ length: 14 }, (_, i) => `c${i}`),
    });
    const rows = [...parser.push(ppomText), ...parser.end()];
    const meta = JSON.parse(rows[0].c12 as string) as Record<
      string,
      { title: string; checked: string }
    >;
    expect(meta['1'].title).toBe('Välj detaljer i designen');
    expect(meta['1'].checked).toBe(
      'Student 2026\r\nStudentmössa\r\nSvensk flagga\r\nNallebjörn',
    );
  });
});
