import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';

/**
 * Stable codes for multer's limit errors. Nest turns a multer `LIMIT_*`
 * error into a bare `PayloadTooLargeException` / `BadRequestException`
 * whose only hint is multer's English message (see
 * `@nestjs/platform-express` `transformException`), so clients would show
 * raw text. Every multipart route gets the same coded envelope instead:
 *   - via `uploadLimit(maxBytes)` (uploads module) when the route knows its
 *     cap, so `max_bytes`/`params.max_mb` travel with the error;
 *   - via the global `AllExceptionsFilter` as a safety net for routes that
 *     do not wrap their `FileInterceptor`.
 */
export const UPLOAD_FILE_TOO_LARGE = 'UPLOAD_FILE_TOO_LARGE';
export const UPLOAD_TOO_MANY_FILES = 'UPLOAD_TOO_MANY_FILES';
export const UPLOAD_UNEXPECTED_FIELD = 'UPLOAD_UNEXPECTED_FIELD';

/** multer error message → code (Nest keeps multer's message verbatim, optionally suffixed ` - <field>`). */
const MULTER_LIMIT_CODES: ReadonlyArray<readonly [string, string]> = [
  ['File too large', UPLOAD_FILE_TOO_LARGE],
  ['Too many files', UPLOAD_TOO_MANY_FILES],
  ['Unexpected field', UPLOAD_UNEXPECTED_FIELD],
];

/** The code of a multer limit error by its message, else `undefined`. */
export function multerLimitCode(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  for (const [text, code] of MULTER_LIMIT_CODES) {
    if (message === text || message.startsWith(`${text} - `)) return code;
  }
  return undefined;
}

export const bytesToMb = (bytes: number): number =>
  Math.round((bytes / (1024 * 1024)) * 10) / 10;

/**
 * The coded exception for a Nest-transformed multer limit error, or `err`
 * unchanged when it is not one (or already carries a code).
 */
export function codedMulterLimitError(err: unknown, maxBytes?: number): unknown {
  if (!(err instanceof HttpException)) return err;
  const res = err.getResponse();
  const message =
    typeof res === 'string' ? res : (res as { message?: unknown }).message;
  if (typeof res !== 'string' && typeof (res as { code?: unknown }).code === 'string') {
    return err;
  }
  const code = multerLimitCode(message);
  if (!code) return err;
  const maxMb = maxBytes !== undefined ? bytesToMb(maxBytes) : undefined;
  if (code === UPLOAD_FILE_TOO_LARGE) {
    return new PayloadTooLargeException({
      code,
      message:
        maxMb !== undefined
          ? `File too large (max ${maxMb} MB)`
          : 'File too large',
      ...(maxBytes !== undefined
        ? { max_bytes: maxBytes, params: { max_mb: maxMb } }
        : {}),
    });
  }
  return new BadRequestException({
    code,
    message:
      code === UPLOAD_TOO_MANY_FILES
        ? 'Too many files in one request'
        : 'Unexpected file field',
  });
}
