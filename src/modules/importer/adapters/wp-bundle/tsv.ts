/**
 * WP-CLI / mysql `--batch` TSV reader (M4.4 §5.1 `tsv.ts`).
 *
 * Format facts (verified on the Namez export, Discovery C L3-L6):
 * - Fields are separated by a raw TAB, rows by a raw LF. A TAB, LF, NUL or
 *   backslash inside a value is escaped as `\t`, `\n`, `\0`, `\\`.
 * - A raw CR is NOT escaped (it appears inside post content), so CR is data.
 * - SQL NULL is the bare token `NULL`. (mysql prints the string 'NULL' the
 *   same way; that ambiguity is inherent to the format.)
 * - Legacy bundles have no header row (fixed column orders); bundle v1 has one.
 *
 * Multi-line safety (only matters for exports made without escaping): when
 * the column count is known and a physical line has too few fields, it is
 * either the continuation of the previous row's last field (one field that
 * does not look like a row start) and is appended to it, or the start of a
 * row whose middle field holds a line break, joined with the following lines
 * until complete. Both report `W_TSV_ROW_JOINED`. Rows with a wrong field
 * count are dropped (`W_TSV_ROW_INVALID`). The last row is held back one
 * line for this, so `push()` returns rows with a one-line delay.
 *
 * The parser is incremental (`TsvStreamParser.push/end`) so a 200 MB file can
 * be read as a stream of chunks; `parseTsv` is the whole-string convenience.
 */

export const TSV_DEFAULT_MAX_VALUE_BYTES = 16 * 1024 * 1024;
export const TSV_DEFAULT_MAX_ROW_CHARS = 64 * 1024 * 1024;

export type TsvValue = string | null;
export type TsvRow = Record<string, TsvValue>;

export interface TsvIssue {
  code: 'W_TSV_ROW_JOINED' | 'W_TSV_ROW_INVALID';
  line: number;
  message: string;
}

export interface TsvOptions {
  /**
   * Fixed column names (legacy bundles). With `header: true` the header row
   * wins and these become the required set.
   */
  columns?: readonly string[];
  /** First non-empty line is a header row. */
  header?: boolean;
  /**
   * Minimum number of fields per row (trailing optional columns, e.g.
   * `terms.term_order`). Defaults to the number of columns.
   */
  minColumns?: number;
  /** Re-join rows that were split by an unescaped LF (default true when the column count is known). */
  joinShortRows?: boolean;
  /**
   * Pattern a row's first field matches, used to tell a new row from the
   * continuation of the previous row's last field. Default: digits when the
   * first column is an id column, else none (short lines are continuations).
   */
  rowStart?: RegExp | null;
  /** `auto` decides from the first line (CRLF if it ends with CR). */
  lineEnding?: 'auto' | 'lf' | 'crlf';
  /** Bare token that means SQL NULL; `false` disables NULL detection. */
  nullToken?: string | false;
  maxValueBytes?: number;
  maxRowChars?: number;
  maxRows?: number;
  /** Used in error messages. */
  fileName?: string;
}

export class TsvParseError extends Error {
  readonly code = 'IMPORT_BUNDLE_PARSE_FAILED';
  constructor(
    message: string,
    readonly line: number,
    readonly fileName?: string,
  ) {
    super(
      fileName ? `${fileName}:${line}: ${message}` : `line ${line}: ${message}`,
    );
    this.name = 'TsvParseError';
  }
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  '\\': '\\',
  '0': '\0',
  r: '\r',
  b: '\b',
  Z: '\x1a',
};

/** Decode one raw field. Unknown escapes keep both characters (like WP-CLI readers do). */
export function unescapeWpCliField(
  raw: string,
  nullToken: string | false = 'NULL',
): TsvValue {
  if (nullToken !== false && raw === nullToken) return null;
  if (raw.indexOf('\\') === -1) return raw;
  let out = '';
  let start = 0;
  let i = raw.indexOf('\\');
  while (i !== -1) {
    out += raw.slice(start, i);
    if (i + 1 >= raw.length) {
      out += '\\';
      start = i + 1;
      break;
    }
    const next = raw[i + 1];
    const mapped = ESCAPES[next];
    out += mapped !== undefined ? mapped : '\\' + next;
    start = i + 2;
    i = raw.indexOf('\\', start);
  }
  if (start < raw.length) out += raw.slice(start);
  return out;
}

function countFields(line: string): number {
  let n = 1;
  for (let i = line.indexOf('\t'); i !== -1; i = line.indexOf('\t', i + 1)) n++;
  return n;
}

export class TsvStreamParser {
  private carry = '';
  /** Forward join: a row that started with too few fields. */
  private pending: { text: string; firstLine: number } | null = null;
  /** The last complete row, held back one line so a continuation can be appended to its last field. */
  private held: { text: string; firstLine: number; joined: boolean } | null =
    null;
  private lineNo = 0;
  private started = false;
  private crlf: boolean | null;
  private cols: string[] | null;
  private readonly minCols: number | null;
  private readonly maxCols: number | null;
  private readonly rowStart: RegExp | null;
  private readonly opts: Required<
    Pick<TsvOptions, 'maxValueBytes' | 'maxRowChars' | 'maxRows'>
  > &
    TsvOptions;
  private rowCount = 0;
  readonly issues: TsvIssue[] = [];

  constructor(options: TsvOptions = {}) {
    this.opts = {
      maxValueBytes: TSV_DEFAULT_MAX_VALUE_BYTES,
      maxRowChars: TSV_DEFAULT_MAX_ROW_CHARS,
      maxRows: Number.MAX_SAFE_INTEGER,
      ...options,
    };
    this.crlf =
      options.lineEnding === 'crlf'
        ? true
        : options.lineEnding === 'lf'
          ? false
          : null;
    this.cols = options.header
      ? null
      : options.columns
        ? [...options.columns]
        : null;
    if (!options.header && options.columns) {
      this.maxCols = options.columns.length;
      this.minCols = options.minColumns ?? options.columns.length;
    } else {
      this.maxCols = null;
      this.minCols = null;
    }
    const first = options.columns?.[0] ?? '';
    this.rowStart =
      options.rowStart !== undefined
        ? options.rowStart
        : /(^|_)id$/i.test(first)
          ? /^\d+$/
          : null;
  }

  /** Column names (known after the header row in header mode). */
  get columns(): string[] | null {
    return this.cols;
  }

  push(chunk: string): TsvRow[] {
    if (!this.started) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    const out: TsvRow[] = [];
    let text = this.carry + chunk;
    let nl = text.indexOf('\n');
    let start = 0;
    while (nl !== -1) {
      this.handleLine(text.slice(start, nl), out);
      start = nl + 1;
      nl = text.indexOf('\n', start);
    }
    text = text.slice(start);
    this.checkSize(text, this.lineNo + 1);
    this.carry = text;
    return out;
  }

  end(): TsvRow[] {
    const out: TsvRow[] = [];
    if (this.carry.length > 0) {
      const last = this.carry;
      this.carry = '';
      this.handleLine(last, out);
    }
    this.flushHeld(out);
    if (this.pending) {
      const { text, firstLine } = this.pending;
      this.pending = null;
      this.issues.push({
        code: 'W_TSV_ROW_INVALID',
        line: firstLine,
        message: `incomplete row at end of file (${countFields(text)} fields)`,
      });
    }
    return out;
  }

  private minFields(): number {
    return this.minCols ?? (this.cols as string[]).length;
  }

  private checkSize(text: string, line: number): void {
    if (text.length > this.opts.maxRowChars) {
      throw new TsvParseError(
        'row exceeds the size limit',
        line,
        this.opts.fileName,
      );
    }
  }

  private handleLine(line: string, out: TsvRow[]): void {
    this.lineNo++;
    if (this.crlf === null) this.crlf = line.endsWith('\r');
    if (this.crlf && line.endsWith('\r')) line = line.slice(0, -1);

    if (this.pending) {
      const joined = this.pending.text + '\n' + line;
      this.checkSize(joined, this.pending.firstLine);
      if (countFields(joined) < this.minFields()) {
        this.pending.text = joined;
        return;
      }
      const firstLine = this.pending.firstLine;
      this.pending = null;
      this.flushHeld(out);
      this.held = { text: joined, firstLine, joined: true };
      return;
    }

    // Empty lines are row separators only (a blank line inside an unescaped
    // value cannot be told apart from one between rows).
    if (line.length === 0) return;

    if (this.cols === null) {
      this.readHeader(line);
      return;
    }

    const n = countFields(line);
    const minCols = this.minFields();
    const joinShort = (this.opts.joinShortRows ?? true) && minCols > 1;
    if (n >= minCols || !joinShort) {
      this.flushHeld(out);
      this.held = { text: line, firstLine: this.lineNo, joined: false };
      return;
    }
    const tab = line.indexOf('\t');
    const firstField = tab === -1 ? line : line.slice(0, tab);
    const startsRow = this.rowStart !== null && this.rowStart.test(firstField);
    if (this.held && !startsRow && n === 1) {
      // Continuation of the previous row's last field.
      this.held.text += '\n' + line;
      this.held.joined = true;
      this.checkSize(this.held.text, this.held.firstLine);
      return;
    }
    // Start of a row whose middle field contains a line break.
    this.flushHeld(out);
    this.pending = { text: line, firstLine: this.lineNo };
  }

  private readHeader(line: string): void {
    this.cols = line
      .split('\t')
      .map((c) => (unescapeWpCliField(c, false) as string).trim());
    const required = this.opts.columns;
    if (required) {
      const missing = required
        .slice(0, this.opts.minColumns ?? required.length)
        .filter((c) => !this.cols!.includes(c));
      if (missing.length) {
        throw new TsvParseError(
          `header is missing columns: ${missing.join(', ')}`,
          this.lineNo,
          this.opts.fileName,
        );
      }
    }
  }

  private flushHeld(out: TsvRow[]): void {
    if (!this.held) return;
    const { text, firstLine, joined } = this.held;
    this.held = null;
    if (joined) {
      this.issues.push({
        code: 'W_TSV_ROW_JOINED',
        line: firstLine,
        message: `row starting at line ${firstLine} spans several lines and was re-joined (unescaped line break)`,
      });
    }
    this.emit(text, firstLine, out);
  }

  private emit(line: string, lineNo: number, out: TsvRow[]): void {
    const cols = this.cols as string[];
    const raw = line.split('\t');
    const minCols = this.minCols ?? cols.length;
    const maxCols = this.maxCols ?? cols.length;
    if (raw.length < minCols || raw.length > maxCols) {
      this.issues.push({
        code: 'W_TSV_ROW_INVALID',
        line: lineNo,
        message: `expected ${minCols === maxCols ? maxCols : `${minCols}-${maxCols}`} fields, got ${raw.length}; row skipped`,
      });
      return;
    }
    if (++this.rowCount > this.opts.maxRows) {
      throw new TsvParseError(
        `more than ${this.opts.maxRows} rows`,
        lineNo,
        this.opts.fileName,
      );
    }
    const nullToken =
      this.opts.nullToken === undefined ? 'NULL' : this.opts.nullToken;
    const row: TsvRow = {};
    for (let i = 0; i < cols.length; i++) {
      const field = raw[i];
      if (
        field !== undefined &&
        field.length * 3 > this.opts.maxValueBytes &&
        Buffer.byteLength(field, 'utf8') > this.opts.maxValueBytes
      ) {
        throw new TsvParseError(
          `value in column ${cols[i]} exceeds ${this.opts.maxValueBytes} bytes`,
          lineNo,
          this.opts.fileName,
        );
      }
      const value =
        field === undefined ? null : unescapeWpCliField(field, nullToken);
      Object.defineProperty(row, cols[i], {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    out.push(row);
  }
}

export interface TsvResult {
  columns: string[];
  rows: TsvRow[];
  issues: TsvIssue[];
}

export function parseTsv(text: string, options: TsvOptions = {}): TsvResult {
  const parser = new TsvStreamParser(options);
  const rows = parser.push(text);
  for (const r of parser.end()) rows.push(r);
  return { columns: parser.columns ?? [], rows, issues: parser.issues };
}

/** Incremental parse of an async chunk source (e.g. a decompressed archive entry). */
export async function parseTsvStream(
  chunks: AsyncIterable<string>,
  options: TsvOptions = {},
): Promise<TsvResult> {
  const parser = new TsvStreamParser(options);
  const rows: TsvRow[] = [];
  for await (const chunk of chunks) {
    for (const r of parser.push(chunk)) rows.push(r);
  }
  for (const r of parser.end()) rows.push(r);
  return { columns: parser.columns ?? [], rows, issues: parser.issues };
}
