/**
 * Safe PHP `unserialize` (M4.4 §5.1 `php-unserialize.ts`; port of the
 * reference loader `scratchpad/namez-db/wpdb.py`).
 *
 * - Works on UTF-8 bytes: `s:<n>:"…"` lengths are byte lengths.
 * - Supports N, b, i, d (incl. INF/-INF/NAN), s, a and O. Objects are
 *   returned as plain records with a `__class__` key — no class is ever
 *   instantiated and no magic method can run. `C:` (custom serializers) and
 *   references (`r:`/`R:`) are rejected.
 * - Arrays whose keys are exactly 0..n-1 become JS arrays; other arrays
 *   become plain objects. Keys are set with `defineProperty`, so a key such
 *   as `__proto__` is an ordinary own property (no prototype pollution).
 *   Note: JS objects list integer-like keys first; use `preserveOrder` when
 *   the source order of a mixed-key array matters.
 * - Limits: depth, string size, element count and input size. Malformed
 *   input always throws `PhpUnserializeError`, never crashes or loops.
 */

export interface PhpUnserializeOptions {
  maxDepth?: number;
  maxStringBytes?: number;
  maxElements?: number;
  maxInputBytes?: number;
  /** Return non-list arrays as `PhpOrderedArray` (entries in source order) instead of objects. */
  preserveOrder?: boolean;
}

export type PhpValue =
  | null
  | boolean
  | number
  | string
  | PhpValue[]
  | PhpRecord
  | PhpOrderedArray;
export interface PhpRecord {
  [key: string]: PhpValue;
}
export interface PhpOrderedArray {
  __entries__: [string | number, PhpValue][];
}

export class PhpUnserializeError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at byte ${offset}`);
    this.name = 'PhpUnserializeError';
  }
}

const DEFAULTS: Required<Omit<PhpUnserializeOptions, 'preserveOrder'>> = {
  maxDepth: 64,
  maxStringBytes: 16 * 1024 * 1024,
  maxElements: 1_000_000,
  maxInputBytes: 64 * 1024 * 1024,
};

const C_COLON = 0x3a; // :
const C_SEMI = 0x3b; // ;
const C_QUOTE = 0x22; // "
const C_LBRACE = 0x7b; // {
const C_RBRACE = 0x7d; // }

function setOwn(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

class Reader {
  pos = 0;
  elements = 0;
  constructor(
    readonly buf: Buffer,
    readonly opts: Required<Omit<PhpUnserializeOptions, 'preserveOrder'>> & {
      preserveOrder: boolean;
    },
  ) {}

  fail(msg: string): never {
    throw new PhpUnserializeError(msg, this.pos);
  }

  expect(byte: number): void {
    if (this.buf[this.pos] !== byte)
      this.fail(`expected '${String.fromCharCode(byte)}'`);
    this.pos++;
  }

  /** Read ASCII up to (not including) `term`, consuming the terminator. */
  readUntil(term: number, maxLen = 400): string {
    const end = this.buf.indexOf(term, this.pos);
    if (end === -1 || end - this.pos > maxLen) this.fail(`unterminated token`);
    const s = this.buf.toString('latin1', this.pos, end);
    this.pos = end + 1;
    return s;
  }

  readInt(term: number): number {
    const s = this.readUntil(term, 40);
    if (!/^[+-]?\d+$/.test(s))
      this.fail(`invalid integer ${JSON.stringify(s)}`);
    return Number(s);
  }

  readLength(term: number): number {
    const n = this.readInt(term);
    if (n < 0 || !Number.isSafeInteger(n)) this.fail('invalid length');
    return n;
  }

  count(): void {
    if (++this.elements > this.opts.maxElements) this.fail('too many elements');
  }

  parseValue(depth: number): PhpValue {
    if (depth > this.opts.maxDepth) this.fail('maximum depth exceeded');
    if (this.pos >= this.buf.length) this.fail('unexpected end of input');
    const type = String.fromCharCode(this.buf[this.pos]);
    this.count();
    switch (type) {
      case 'N':
        this.pos++;
        this.expect(C_SEMI);
        return null;
      case 'b': {
        this.pos++;
        this.expect(C_COLON);
        const v = this.readUntil(C_SEMI, 2);
        if (v !== '0' && v !== '1') this.fail('invalid boolean');
        return v === '1';
      }
      case 'i': {
        this.pos++;
        this.expect(C_COLON);
        const s = this.readUntil(C_SEMI, 40);
        if (!/^[+-]?\d+$/.test(s))
          this.fail(`invalid integer ${JSON.stringify(s)}`);
        const n = Number(s);
        // Out-of-range integers are kept as their decimal string.
        return Number.isSafeInteger(n) ? n : s.replace(/^\+/, '');
      }
      case 'd': {
        this.pos++;
        this.expect(C_COLON);
        const s = this.readUntil(C_SEMI, 400);
        if (s === 'INF') return Infinity;
        if (s === '-INF') return -Infinity;
        if (s === 'NAN') return NaN;
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s))
          this.fail(`invalid float ${JSON.stringify(s)}`);
        return Number(s);
      }
      case 's':
        this.pos++;
        this.expect(C_COLON);
        return this.parseStringBody(C_SEMI);
      case 'a': {
        this.pos++;
        this.expect(C_COLON);
        const n = this.readLength(C_COLON);
        this.expect(C_LBRACE);
        const v = this.parseEntries(n, depth);
        this.expect(C_RBRACE);
        return v;
      }
      case 'O': {
        this.pos++;
        this.expect(C_COLON);
        const cls = this.parseStringBody(C_COLON, 512);
        if (!/^[A-Za-z_\\][A-Za-z0-9_\\]*$/.test(cls))
          this.fail('invalid class name');
        const n = this.readLength(C_COLON);
        this.expect(C_LBRACE);
        const rec: PhpRecord = {};
        setOwn(rec, '__class__', cls);
        for (let i = 0; i < n; i++) {
          const k = this.parseKey(depth);
          const v = this.parseValue(depth + 1);
          // Protected/private property names carry NUL-delimited prefixes.
          const name = String(k).replace(/^\0(?:\*|[^\0]*)\0/, '');
          setOwn(rec, name, v);
        }
        this.expect(C_RBRACE);
        return rec;
      }
      case 'C':
        return this.fail('custom-serialized objects (C:) are not supported');
      case 'r':
      case 'R':
        return this.fail('references (r:/R:) are not supported');
      default:
        return this.fail(`unknown type ${JSON.stringify(type)}`);
    }
  }

  /** `<len>:"<bytes>"<term>` — the caller already consumed the type and colon. */
  parseStringBody(term: number, maxBytes = this.opts.maxStringBytes): string {
    const len = this.readLength(C_COLON);
    if (len > maxBytes) this.fail('string exceeds the size limit');
    this.expect(C_QUOTE);
    const end = this.pos + len;
    if (end > this.buf.length)
      this.fail('string length runs past the end of input');
    const s = this.buf.toString('utf8', this.pos, end);
    this.pos = end;
    this.expect(C_QUOTE);
    this.expect(term);
    return s;
  }

  parseKey(depth: number): string | number {
    const t = String.fromCharCode(this.buf[this.pos]);
    if (t !== 'i' && t !== 's') this.fail('array keys must be int or string');
    const k = this.parseValue(depth + 1);
    return k as string | number;
  }

  parseEntries(n: number, depth: number): PhpValue {
    const entries: [string | number, PhpValue][] = [];
    let isList = true;
    for (let i = 0; i < n; i++) {
      const k = this.parseKey(depth);
      const v = this.parseValue(depth + 1);
      if (k !== i) isList = false;
      entries.push([k, v]);
    }
    if (isList) return entries.map((e) => e[1]);
    if (this.opts.preserveOrder) return { __entries__: entries };
    const obj: PhpRecord = {};
    for (const [k, v] of entries) setOwn(obj, String(k), v);
    return obj;
  }
}

export function phpUnserialize(
  input: string | Buffer,
  options: PhpUnserializeOptions = {},
): PhpValue {
  const opts = {
    ...DEFAULTS,
    ...options,
    preserveOrder: options.preserveOrder ?? false,
  };
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (buf.length > opts.maxInputBytes)
    throw new PhpUnserializeError('input exceeds the size limit', 0);
  const r = new Reader(buf, opts);
  const v = r.parseValue(0);
  if (r.pos !== buf.length) {
    // WordPress tolerates trailing whitespace only.
    const rest = buf.toString('latin1', r.pos);
    if (rest.trim() !== '')
      throw new PhpUnserializeError('trailing data after value', r.pos);
  }
  return v;
}

/** WordPress `is_serialized()` (strict form). */
export function isPhpSerialized(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s === 'N;') return true;
  if (s.length < 4 || s[1] !== ':') return false;
  switch (s[0]) {
    case 's':
      return /^s:\d+:".*";$/s.test(s);
    case 'a':
    case 'O':
      return /^[aO]:\d+:/.test(s) && /[;}]$/.test(s);
    case 'b':
    case 'i':
    case 'd':
      return /^[bid]:[^;]*;$/.test(s);
    default:
      return false;
  }
}

export type MaybeUnserialized =
  | { ok: true; serialized: boolean; value: PhpValue }
  | { ok: false; serialized: true; value: string; error: string };

/**
 * WordPress `maybe_unserialize()`: unserialize when the string looks
 * serialized, otherwise return it unchanged. Failures are reported, not thrown.
 */
export function maybeUnserialize(
  value: string | null,
  options?: PhpUnserializeOptions,
): MaybeUnserialized {
  if (value === null) return { ok: true, serialized: false, value: null };
  if (!isPhpSerialized(value)) return { ok: true, serialized: false, value };
  try {
    return {
      ok: true,
      serialized: true,
      value: phpUnserialize(value.trim(), options),
    };
  } catch (e) {
    return { ok: false, serialized: true, value, error: (e as Error).message };
  }
}
