import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { promises as fs } from 'fs';
import multer, { diskStorage } from 'multer';
import * as path from 'path';
import { catchError, finalize, Observable, throwError } from 'rxjs';
import type { RequestUser } from '../../common/decorators/current-user.decorator';
import {
  codedMulterLimitError,
  UPLOAD_TOO_MANY_FILES,
  UPLOAD_UNEXPECTED_FIELD,
} from '../../common/filters/multer-limit-errors';
import { sanitizeFolder } from '../storage/public-storage';
import { UploadsService } from './uploads.service';
import {
  videoTooLarge,
  videoTypeError,
  videoUploadConfig,
} from './video-upload.config';

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

/**
 * `POST /uploads/video` (CONTRACT §4.3 steps 1–4). Runs the cheap checks
 * BEFORE the body is read (feature flag, role/folder, Content-Length, free
 * disk, quota), then streams the single `file` part to the video temp dir
 * with multer diskStorage (never into memory), with limits read from the
 * env at request time. The temp file is removed after the handler, on every
 * outcome (the service also removes it).
 */
@Injectable()
export class VideoUploadInterceptor implements NestInterceptor {
  constructor(private readonly uploads: UploadsService) {}

  async intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & { user?: RequestUser }>();
    const res = http.getResponse<Response>();
    const folder = sanitizeFolder(
      typeof req.query?.folder === 'string' ? req.query.folder : 'products',
    );
    const declared = Number(req.headers['content-length']);
    await this.uploads.assertVideoPrecheck(
      req.user,
      folder,
      Number.isFinite(declared) && declared >= 0 ? declared : null,
    );

    const cfg = videoUploadConfig();
    await fs.mkdir(cfg.tmpDir, { recursive: true });
    await runVideoMulter(req, res, cfg.tmpDir, cfg.maxBytes);
    const tempPath = (req as { file?: Express.Multer.File }).file?.path;
    const cleanup = () => {
      if (tempPath) void fs.unlink(tempPath).catch(() => undefined);
    };
    return next.handle().pipe(finalize(cleanup));
  }
}

/** One `file` part to `<tmpDir>/<uuid>.upload`, with coded limit errors. */
function runVideoMulter(
  req: Request,
  res: Response,
  tmpDir: string,
  maxBytes: number,
): Promise<void> {
  const upload = multer({
    storage: diskStorage({
      destination: tmpDir,
      filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 5, parts: 8 },
    fileFilter: (_req, file, cb) => {
      if (path.extname(file.originalname || '').toLowerCase() !== '.mp4') {
        cb(videoTypeError('extension'));
        return;
      }
      cb(null, true);
    },
  }).single('file');
  return new Promise<void>((resolve, reject) => {
    upload(req, res, (err: unknown) => {
      if (!err) {
        resolve();
        return;
      }
      if (err instanceof HttpException) {
        reject(err);
        return;
      }
      const code = (err as { code?: string }).code;
      if (code === 'LIMIT_FILE_SIZE') {
        reject(videoTooLarge(maxBytes));
        return;
      }
      if (code === 'LIMIT_FILE_COUNT') {
        reject(
          new BadRequestException({
            code: UPLOAD_TOO_MANY_FILES,
            message: 'Too many files in one request',
          }),
        );
        return;
      }
      if (code === 'LIMIT_UNEXPECTED_FILE') {
        reject(
          new BadRequestException({
            code: UPLOAD_UNEXPECTED_FIELD,
            message: 'Unexpected file field',
          }),
        );
        return;
      }
      reject(
        new BadRequestException({
          code: 'UPLOAD_VIDEO_UNREADABLE',
          message: 'The upload could not be read',
        }),
      );
    });
  });
}
