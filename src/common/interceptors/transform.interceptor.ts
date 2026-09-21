import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface SuccessResponse<T> {
  success: true;
  data: T;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  SuccessResponse<T> | StreamableFile
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessResponse<T> | StreamableFile> {
    return next.handle().pipe(
      // File downloads (CSV reports) are streamed as-is: Nest writes the
      // body itself, so wrapping them in the envelope would corrupt them.
      map((data: T | StreamableFile) =>
        data instanceof StreamableFile
          ? data
          : {
              success: true as const,
              data,
              timestamp: new Date().toISOString(),
            },
      ),
    );
  }
}
