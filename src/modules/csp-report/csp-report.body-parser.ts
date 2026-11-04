import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Content types browsers use for CSP reports. Nest's built-in JSON parser
 * only handles `application/json`, so these would otherwise reach the
 * controller with an empty body.
 */
export const CSP_REPORT_CONTENT_TYPES = [
  'application/csp-report',
  'application/reports+json',
];

/** Reports are tiny; anything larger is refused before it is buffered. */
export const CSP_REPORT_BODY_LIMIT = '16kb';

const parse = json({
  type: CSP_REPORT_CONTENT_TYPES,
  limit: CSP_REPORT_BODY_LIMIT,
});

/**
 * Body parser for `POST /api/csp-report` only. A body that is already parsed
 * (plain `application/json`, handled by the global parser) is left alone.
 * Parser errors answer here with a bare status (413 too large, 400 bad JSON)
 * so they never reach the generic error output.
 */
export function cspReportBodyParser(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  parse(req, res, (err?: unknown) => {
    if (err) {
      const status = (err as { status?: number }).status === 413 ? 413 : 400;
      res.status(status).end();
      return;
    }
    next();
  });
}
