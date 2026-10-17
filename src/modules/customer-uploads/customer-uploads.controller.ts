import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { catchError, from, Observable, switchMap, throwError } from 'rxjs';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { CustomerUploadsService } from './customer-uploads.service';
import { CUSTOMER_UPLOAD_MAX_BYTES } from './customer-uploads.types';

/**
 * Gives multer's size-limit error the coded body the storefront translates
 * (`UPLOAD_FILE_TOO_LARGE`) instead of Nest's bare 413.
 */
@Injectable()
export class CustomerUploadLimitInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) =>
        throwError(() =>
          err instanceof PayloadTooLargeException
            ? new PayloadTooLargeException({
                code: 'UPLOAD_FILE_TOO_LARGE',
                message: 'File too large (max 50MB)',
                params: { max_mb: CUSTOMER_UPLOAD_MAX_BYTES / (1024 * 1024) },
              })
            : err,
        ),
      ),
    );
  }
}

/**
 * Runs before multer reads the body: refuses a client whose daily byte
 * budget is used up (429 CUSTOMER_UPLOAD_QUOTA) or a server low on disk
 * (503 CUSTOMER_UPLOAD_STORAGE_FULL) without buffering up to 50 MB first.
 */
@Injectable()
export class CustomerUploadAdmissionInterceptor implements NestInterceptor {
  constructor(private readonly customerUploads: CustomerUploadsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    return from(this.customerUploads.admit({ ip: req.ip })).pipe(
      switchMap(() => next.handle()),
    );
  }
}

/**
 * Storefront customer uploads (M4.0 §8.2), mounted at `/api/uploads/customer`.
 */
@Controller('uploads/customer')
export class CustomerUploadsController {
  constructor(private readonly customerUploads: CustomerUploadsService) {}

  /**
   * Public (guests personalize products too), throttled like
   * `/uploads/public`. Multipart field `file`.
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(
    CustomerUploadAdmissionInterceptor,
    CustomerUploadLimitInterceptor,
    FileInterceptor('file', {
      limits: { fileSize: CUSTOMER_UPLOAD_MAX_BYTES, files: 1 },
    }),
  )
  upload(@Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    // req.ip is the real client only behind a proxy when TRUST_PROXY is set.
    return this.customerUploads.upload(file, { ip: req.ip });
  }

  /** The exact original bytes, for readers of an order that uses the upload. */
  @Get(':id/original')
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async original(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const { stream, length, mime, filename } =
      await this.customerUploads.downloadOriginal(id, user);
    // Customer bytes are untrusted: never sniffed, never run as a document
    // (a PDF/SVG opened in place gets an opaque, script-less origin).
    res?.setHeader('X-Content-Type-Options', 'nosniff');
    res?.setHeader('Content-Security-Policy', 'sandbox');
    // Private customer originals must never be stored by shared caches.
    res?.setHeader('Cache-Control', 'private, no-store');
    // Streamed from disk: a 50 MB original never sits in memory (M5 A5).
    return new StreamableFile(stream, {
      type: mime,
      disposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
      length,
    });
  }
}
