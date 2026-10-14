import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    // A response already on the wire (a streamed file, a manual send) cannot
    // take a JSON error on top; writing again would only throw
    // ERR_HTTP_HEADERS_SENT.
    if (response.headersSent) return;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: unknown = 'Internal server error';
    // Stable machine-readable error code (when a thrower provides one). Clients
    // translate `errors.<code>` and fall back to `message`.
    let code: string | undefined;
    // Any further keys a thrower put next to code/message (e.g. the DNS
    // records a failed domain verify observed) travel with the error.
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else {
        const r = res as Record<string, unknown>;
        // `message` may be a string or an array (class-validator) — preserve it.
        if (r.message !== undefined) message = r.message;
        if (typeof r.code === 'string') code = r.code;
        const { message: _m, code: _c, statusCode: _s, error: _e, ...rest } = r;
        void _m;
        void _c;
        void _s;
        void _e;
        extra = rest;
      }
    } else {
      // Log unexpected errors for debugging
      console.error('[UnhandledException]', exception);
    }

    response.status(status).json({
      ...extra,
      success: false,
      statusCode: status,
      message,
      code,
      timestamp: new Date().toISOString(),
    });
  }
}
