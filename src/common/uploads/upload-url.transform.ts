/**
 * Write-path normalisation of public upload URLs (S3 project, SPEC.md
 * "Database rows keep their current values": new writes are normalised on
 * the API side).
 *
 * The dashboard sends the URL it got back from `POST /uploads` absolutised
 * with the API host (`https://<api>/uploads/products/x.webp`). Stored
 * values should be the relative `/uploads/...` form, which keeps working
 * when the API host, the CDN origin or the storage driver changes. Only
 * URLs whose host is one of OUR hosts are rewritten: `PUBLIC_API_URL`,
 * every entry of `API_PUBLIC_ORIGINS` (comma separated), `MEDIA_BASE_URL`
 * and `localhost:3001` (dev). Foreign URLs, relative paths and plain text
 * are returned unchanged, so nothing that is not an upload URL of ours is
 * ever touched.
 *
 * Domain move: while the old API host still serves `/uploads/*`, list BOTH
 * API origins in `API_PUBLIC_ORIGINS` (e.g. `https://api.shopsdoor.com,
 * https://ms-api.iwings-digital.com`) so a dashboard built against either
 * host, and the personalization file-URL check, keep normalising / accepting
 * URLs of both. No code default carries a host name.
 *
 * Deliberately NOT applied to customer personalization values
 * (`OrderCustomFieldValue`, `CartItem.custom_fields`): the personalization
 * core validates absolute customer-file URLs against the same origins and
 * the checkout/Kustom flow round-trips them as sent; rewriting them there
 * would change validated payloads mid-flight.
 */
import { Transform } from 'class-transformer';
import { normalizeUploadUrl, normalizeUploadUrlsInJson } from './upload-url';

/** Our API hosts from the environment (host[:port] strings or origins). */
export function apiUploadHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const v = raw?.trim();
    if (v) out.push(v);
  };
  add(env.PUBLIC_API_URL);
  for (const part of (env.API_PUBLIC_ORIGINS ?? '').split(',')) add(part);
  add(env.MEDIA_BASE_URL);
  return out;
}

/** `https://<our host>/uploads/...` → `/uploads/...`; anything else unchanged. */
export function normalizeApiUploadUrl<T>(value: T): T {
  if (typeof value !== 'string') return value;
  return normalizeUploadUrl(value, apiUploadHosts()) as T;
}

/** Every string leaf of a JSON value passed through the same rule. */
export function normalizeApiUploadJson<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  return normalizeUploadUrlsInJson(value, apiUploadHosts()).value;
}

/**
 * DTO decorator for a URL column (`ProductImage.url`, avatars, logos,
 * thumbnails, ...). Works on a string or an array of strings; other values
 * pass through untouched so the validators still see them.
 */
export function UploadUrl(): PropertyDecorator {
  return Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(normalizeApiUploadUrl);
    return normalizeApiUploadUrl(value);
  });
}

/**
 * DTO decorator for a JSON column that may embed upload URLs anywhere
 * (page sections, SEO, custom-field `ui`, template definitions).
 */
export function UploadUrlsInJson(): PropertyDecorator {
  return Transform(({ value }) => normalizeApiUploadJson(value));
}
