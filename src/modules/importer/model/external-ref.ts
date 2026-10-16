/**
 * External identity: `woo:<site_host>:<kind>:<id>` (M4-INTEGRATION C7, M4.4 D2).
 * Persisted kinds: product, variation, product_cat, product_tag, npp_template.
 * The other kinds are importer-internal (ledger / media / report only).
 */

export const EXTERNAL_REF_KINDS = [
  'product',
  'variation',
  'product_cat',
  'product_tag',
  'npp_template',
  'attachment',
  'attribute',
  'term',
  'shipping_class',
  'shipping_zone',
] as const;

export type ExternalRefKind = (typeof EXTERNAL_REF_KINDS)[number];

/** Columns are VarChar(191) (C5/C7). */
export const EXTERNAL_REF_MAX_LENGTH = 191;

const HOST_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Lower-case host without scheme, port, path or trailing dot. Throws on anything else. */
export function normalizeSiteHost(input: string): string {
  let host = String(input ?? '')
    .trim()
    .toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/)[0];
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || host.length > 253 || !HOST_RE.test(host)) {
    throw new Error(`Invalid site host: ${JSON.stringify(input)}`);
  }
  return host;
}

export function buildExternalRef(
  siteHost: string,
  kind: ExternalRefKind,
  id: string | number,
): string {
  const host = normalizeSiteHost(siteHost);
  const idStr = String(id);
  if (!ID_RE.test(idStr))
    throw new Error(`Invalid external id: ${JSON.stringify(idStr)}`);
  const ref = `woo:${host}:${kind}:${idStr}`;
  if (ref.length > EXTERNAL_REF_MAX_LENGTH)
    throw new Error('External ref too long');
  return ref;
}

export interface ParsedExternalRef {
  host: string;
  kind: ExternalRefKind;
  id: string;
}

export function parseExternalRef(ref: string): ParsedExternalRef | null {
  if (typeof ref !== 'string' || ref.length > EXTERNAL_REF_MAX_LENGTH)
    return null;
  const m = /^woo:([^:]+):([a-z_]+):([^:]+)$/.exec(ref);
  if (!m) return null;
  const [, host, kind, id] = m;
  if (!(EXTERNAL_REF_KINDS as readonly string[]).includes(kind)) return null;
  if (!HOST_RE.test(host) || !ID_RE.test(id)) return null;
  return { host, kind: kind as ExternalRefKind, id };
}

/** Bound helper for one source host. */
export function refFactory(siteHost: string) {
  const host = normalizeSiteHost(siteHost);
  return (kind: ExternalRefKind, id: string | number) =>
    buildExternalRef(host, kind, id);
}
