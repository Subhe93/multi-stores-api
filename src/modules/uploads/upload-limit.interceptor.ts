import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, Observable, throwError } from 'rxjs';
import { codedMulterLimitError } from '../../common/filters/multer-limit-errors';

/**
 * Gives multer's limit errors (`LIMIT_FILE_SIZE`, `LIMIT_FILE_COUNT`,
 * `LIMIT_UNEXPECTED_FILE`) the coded envelope clients translate —
 * `413 UPLOAD_FILE_TOO_LARGE` with `max_bytes` — instead of Nest's bare 413.
 * Apply before the `FileInterceptor`:
 * `@UseInterceptors(uploadLimit(MAX), FileInterceptor('file', { limits: { fileSize: MAX } }))`.
 */
export function uploadLimit(maxBytes: number) {
  @Injectable()
  class UploadLimitInterceptor implements NestInterceptor {
    intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
      return next
        .handle()
        .pipe(
          catchError((err: unknown) =>
            throwError(() => codedMulterLimitError(err, maxBytes)),
          ),
        );
    }
  }
  return UploadLimitInterceptor;
}
