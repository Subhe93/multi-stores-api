/**
 * `/uploads/*` in s3 mode: an Express handler (mounted by main.ts outside the
 * `/api` prefix, in place of `useStaticAssets`) that streams the object from
 * `PublicStorage.getForServing` with the same headers the static handler
 * sends today, so browsers and Cloudflare keep caching:
 *
 * - `Cache-Control: public, max-age=31536000, immutable` (uuid file names);
 *   `customer-previews/` → `public, max-age=86400` + `X-Robots-Tag: noindex`;
 * - `.svg` → `Content-Disposition: attachment` (never rendered as a document
 *   on this origin);
 * - `ETag` / `Last-Modified` (+ `If-None-Match` / `If-Modified-Since` → 304),
 *   `Content-Length`, `X-Content-Type-Options: nosniff`, `Accept-Ranges: none`;
 * - `HEAD` answers headers only; other methods fall through (404);
 * - only `uploads/<folder>/<file>` (or one extra segment) is looked up: `..`,
 *   backslashes, encoded slashes and anything else answer 404 without a read.
 */
import type { NextFunction, Request, Response } from 'express';
import { isPublicMediaKey, publicObjectHeaders } from './public-storage';
import type { PublicStorage } from './public-storage';
import { contentTypeFor } from './local-object-storage';

export type UploadsRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

/** `/<folder>/<file>` (the path under `/uploads`) → object key, or null. */
export function uploadsPathToKey(urlPath: string): string | null {
  const raw = urlPath.split(/[?#]/, 1)[0];
  if (!raw || raw.includes('\\') || /%2f|%5c|%00/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const key = `uploads/${decoded.replace(/^\/+/, '')}`;
  return isPublicMediaKey(key) ? key : null;
}

function freshByEtag(req: Request, etag: string | null): boolean {
  const inm = req.headers['if-none-match'];
  if (!etag || !inm) return false;
  const tags = (Array.isArray(inm) ? inm.join(',') : inm)
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag.replace(/^W\//, ''));
}

function freshByDate(req: Request, lastModified: Date | null): boolean {
  const ims = req.headers['if-modified-since'];
  if (!lastModified || !ims || Array.isArray(ims)) return false;
  const since = Date.parse(ims);
  if (Number.isNaN(since)) return false;
  // HTTP dates have second precision.
  return Math.floor(lastModified.getTime() / 1000) * 1000 <= since;
}

export function createUploadsServingHandler(
  storage: PublicStorage,
): UploadsRequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const key = uploadsPathToKey(req.path ?? req.url ?? '');
    if (!key) {
      res.status(404).end();
      return;
    }
    void storage
      .getForServing(key)
      .then((obj) => {
        if (!obj) {
          res.status(404).end();
          return;
        }
        const rules = publicObjectHeaders(key);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', rules.cacheControl);
        if (rules.contentDisposition) {
          res.setHeader('Content-Disposition', rules.contentDisposition);
        }
        if (rules.robots) res.setHeader('X-Robots-Tag', rules.robots);
        res.setHeader('Content-Type', obj.contentType || contentTypeFor(key));
        res.setHeader('Accept-Ranges', 'none');
        if (obj.etag) res.setHeader('ETag', obj.etag);
        if (obj.lastModified) {
          res.setHeader('Last-Modified', obj.lastModified.toUTCString());
        }

        // Conditional requests: ETag wins when the client sent one.
        const inm = req.headers['if-none-match'];
        const fresh = inm
          ? freshByEtag(req, obj.etag)
          : freshByDate(req, obj.lastModified);
        if (fresh) {
          obj.stream.destroy();
          res.status(304).end();
          return;
        }

        res.setHeader('Content-Length', String(obj.size));
        if (req.method === 'HEAD') {
          obj.stream.destroy();
          res.status(200).end();
          return;
        }
        res.status(200);
        obj.stream.on('error', () => {
          if (!res.headersSent) res.status(502);
          res.end();
        });
        res.on('close', () => obj.stream.destroy());
        obj.stream.pipe(res);
      })
      .catch(() => {
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
  };
}
