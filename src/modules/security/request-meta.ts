import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Where a security-relevant request came from (for the audit log/alerts). */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMetaFrom(
  req: Pick<Request, 'ip' | 'headers'>,
): RequestMeta {
  const ua = req.headers?.['user-agent'];
  return {
    // req.ip is the real client only when TRUST_PROXY is set (see main.ts).
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
  };
}

/** `@ReqMeta() meta: RequestMeta` in a controller handler. */
export const ReqMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMeta =>
    requestMetaFrom(ctx.switchToHttp().getRequest<Request>()),
);
