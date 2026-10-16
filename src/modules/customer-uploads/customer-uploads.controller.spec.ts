import {
  BadRequestException,
  PayloadTooLargeException,
  StreamableFile,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  CustomerUploadAdmissionInterceptor,
  CustomerUploadLimitInterceptor,
  CustomerUploadsController,
} from './customer-uploads.controller';
import type { CustomerUploadsService } from './customer-uploads.service';

describe('CustomerUploadsController', () => {
  it('maps multer size errors to a coded 413', async () => {
    const i = new CustomerUploadLimitInterceptor();
    const run = (err: unknown) =>
      lastValueFrom(
        i.intercept({} as never, { handle: () => throwError(() => err) }),
      );
    await expect(
      run(new PayloadTooLargeException('File too large')),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'UPLOAD_FILE_TOO_LARGE', params: { max_mb: 50 } },
    });
    const other = new BadRequestException('x');
    await expect(run(other)).rejects.toBe(other);
  });

  it('streams the original as an attachment', async () => {
    const downloadOriginal = jest.fn().mockResolvedValue({
      buffer: Buffer.from('abc'),
      mime: 'image/png',
      filename: 'ORD-1-Photo-0000.png',
    });
    const c = new CustomerUploadsController({
      downloadOriginal,
    } as unknown as CustomerUploadsService);
    const user = {
      id: 'u',
      email: 'e',
      role: UserRole.CREATOR,
      status: 'ACTIVE',
    } as never;
    const setHeader = jest.fn();
    const res = await c.original(user, 'id-1', { setHeader } as never);
    expect(setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      'sandbox',
    );
    expect(res).toBeInstanceOf(StreamableFile);
    expect(res.getHeaders()).toMatchObject({
      type: 'image/png',
      disposition: 'attachment; filename="ORD-1-Photo-0000.png"',
      length: 3,
    });
    expect(downloadOriginal).toHaveBeenCalledWith('id-1', user);
  });

  it('admits before multer: quota / disk errors stop the request', async () => {
    const admit = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('quota'), { code: 'CUSTOMER_UPLOAD_QUOTA' }),
      )
      .mockResolvedValueOnce(undefined);
    const i = new CustomerUploadAdmissionInterceptor({
      admit,
    } as unknown as CustomerUploadsService);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ ip: '203.0.113.9' }) }),
    } as never;
    const handle = jest.fn(() => of('stored'));
    await expect(
      lastValueFrom(i.intercept(ctx, { handle })),
    ).rejects.toMatchObject({ code: 'CUSTOMER_UPLOAD_QUOTA' });
    expect(handle).not.toHaveBeenCalled();
    await expect(lastValueFrom(i.intercept(ctx, { handle }))).resolves.toBe(
      'stored',
    );
    expect(admit).toHaveBeenCalledWith({ ip: '203.0.113.9' });
  });
});
