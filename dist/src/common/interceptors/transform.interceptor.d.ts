import { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
export interface SuccessResponse<T> {
    success: true;
    data: T;
    timestamp: string;
}
export declare class TransformInterceptor<T> implements NestInterceptor<T, SuccessResponse<T>> {
    intercept(context: ExecutionContext, next: CallHandler): Observable<SuccessResponse<T>>;
}
