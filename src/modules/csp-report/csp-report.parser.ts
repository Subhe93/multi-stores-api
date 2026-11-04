/**
 * Pure helpers for Content-Security-Policy violation reports.
 *
 * Two wire formats reach `POST /api/csp-report`:
 * - `report-uri` (legacy): `application/csp-report`,
 *   body `{ "csp-report": { "document-uri", "blocked-uri", "violated-directive",
 *   "effective-directive", "disposition", "source-file", ... } }`.
 * - `report-to` (Reporting API): `application/reports+json`, body is an array
 *   of `{ type: "csp-violation", url, body: { documentURL, blockedURL,
 *   effectiveDirective, disposition, sourceFile, ... } }`.
 *
 * Both are reduced to a small summary. URLs never keep their query string or
 * fragment: a report can carry a page URL with a token in it (magic links,
 * password reset, checkout confirmation), and the summary ends up in logs.
 */

export interface CspViolationSummary {
  /** Effective directive, e.g. `script-src-elem`. */
  directive: string;
  /** Host (or keyword: inline, eval, data, blob, …) of what was blocked. */
  blocked: string;
  /** Host of the page that triggered the violation. */
  document: string;
  /** `report` (Report-Only) or `enforce`. */
  disposition: string;
  /** Blocked URL as origin + path (no query/fragment), when it is a URL. */
  blockedSample: string | null;
  /** Script that caused the violation, origin + path, when reported. */
  sourceSample: string | null;
}

/** Upper bound of reports read from one request body. */
export const MAX_REPORTS_PER_REQUEST = 50;

const MAX_FIELD = 120;
const MAX_SAMPLE = 200;

/** Drop control characters (log injection) and cap the length. */
export function cleanToken(value: unknown, max = MAX_FIELD): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * Origin + path of a URL, with query string and fragment removed. Non-URL
 * values (`inline`, `eval`) come back as a cleaned keyword; a value that
 * looks like a URL but does not parse is cut at the first `?` or `#`.
 */
export function stripUrl(value: unknown, max = MAX_SAMPLE): string {
  const raw = cleanToken(value, 2048);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return cleanToken(`${u.origin}${u.pathname}`, max);
    }
    // data:, blob:, about:, chrome-extension: … only the scheme matters.
    return u.protocol.replace(/:$/, '');
  } catch {
    return cleanToken(raw.split(/[?#]/, 1)[0], max);
  }
}

/** Hostname of a URL, or the keyword / scheme for non-http values. */
export function hostOf(value: unknown): string {
  const raw = cleanToken(value, 2048);
  if (!raw) return 'unknown';
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    }
    return u.protocol.replace(/:$/, '') || 'unknown';
  } catch {
    // Keywords browsers use for blocked-uri: inline, eval, self, wasm-eval,
    // trusted-types-policy, or a bare scheme ("data", "blob").
    const keyword = raw.split(/[?#/:]/, 1)[0].toLowerCase();
    return cleanToken(keyword, 60) || 'unknown';
  }
}

/** Directive name only (`script-src 'self' …` → `script-src`). */
function directiveName(value: unknown): string {
  const v = cleanToken(value, 200).split(' ', 1)[0].toLowerCase();
  return /^[a-z-]{1,40}$/.test(v) ? v : 'unknown';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function summarize(fields: {
  documentUrl: unknown;
  blockedUrl: unknown;
  directive: unknown;
  disposition: unknown;
  sourceFile: unknown;
}): CspViolationSummary {
  const blockedSample = stripUrl(fields.blockedUrl);
  const sourceSample = stripUrl(fields.sourceFile);
  const disposition = cleanToken(fields.disposition, 20).toLowerCase();
  return {
    directive: directiveName(fields.directive),
    blocked: hostOf(fields.blockedUrl),
    document: hostOf(fields.documentUrl),
    disposition: disposition === 'enforce' ? 'enforce' : 'report',
    blockedSample: /^https?:\/\//.test(blockedSample) ? blockedSample : null,
    sourceSample: /^https?:\/\//.test(sourceSample) ? sourceSample : null,
  };
}

/**
 * Parse a report body (either format, already JSON-decoded) into summaries.
 * Unknown shapes yield an empty list; at most MAX_REPORTS_PER_REQUEST.
 */
export function parseCspReports(body: unknown): CspViolationSummary[] {
  const out: CspViolationSummary[] = [];

  // Legacy report-uri format.
  if (isRecord(body) && isRecord(body['csp-report'])) {
    const r = body['csp-report'];
    out.push(
      summarize({
        documentUrl: r['document-uri'],
        blockedUrl: r['blocked-uri'],
        directive: r['effective-directive'] ?? r['violated-directive'],
        disposition: r['disposition'],
        sourceFile: r['source-file'],
      }),
    );
    return out;
  }

  // Reporting API format: an array (some agents send a single object).
  const list = Array.isArray(body) ? body : isRecord(body) ? [body] : [];
  for (const item of list.slice(0, MAX_REPORTS_PER_REQUEST)) {
    if (!isRecord(item) || !isRecord(item.body)) continue;
    if (item.type !== undefined && item.type !== 'csp-violation') continue;
    const b = item.body;
    out.push(
      summarize({
        documentUrl: b.documentURL ?? item.url,
        blockedUrl: b.blockedURL,
        directive: b.effectiveDirective ?? b.violatedDirective,
        disposition: b.disposition,
        sourceFile: b.sourceFile,
      }),
    );
  }
  return out;
}
