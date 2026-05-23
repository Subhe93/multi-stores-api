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

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: unknown = 'Internal server error';
    // Stable machine-readable error code (when a thrower provides one). Clients
    // translate `errors.<code>` and fall back to `message`.
    let code: string | undefined;

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
      }
    } else {
      // Log unexpected errors for debugging
      console.error('[UnhandledException]', exception);
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      code,
      timestamp: new Date().toISOString(),
    });
  }
}
