import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { designerErrorCode } from './designer-errors';
import {
  DesignerPhotoAdmissionInterceptor,
  DesignerUploadAdmission,
  RollingByteBudget,
} from './designer-upload-admission';

const DESIGN = '33333333-3333-4333-8333-333333333333';
const MB = 1024 * 1024;

function build(env: Record<string, string> = {}, photos = 0) {
  const prisma = {
    designAsset: { count: jest.fn(() => Promise.resolve(photos)) },
  };
  const admission = new DesignerUploadAdmission(
    prisma as never,
    { root: __dirname } as never,
  );
  admission.env = {
    DESIGNER_UPLOAD_MIN_FREE_MB: '0',
    ...env,
  } as NodeJS.ProcessEnv;
  return { admission, prisma };
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return designerErrorCode(e);
  }
}

describe('RollingByteBudget', () => {
  it('allows up to the limit, then resets after 24 h', () => {
    let now = 0;
    const b = new RollingByteBudget(
      () => 100,
      () => now,
    );
    expect(b.allows('ip', 100)).toBe(true);
    b.consume('ip', 80);
    expect(b.allows('ip', 30)).toBe(false);
    expect(b.allows('ip', 20)).toBe(true);
    b.consume('ip', 20);
    expect(b.allows('ip')).toBe(false);
    now = 24 * 60 * 60 * 1000;
    expect(b.allows('ip', 100)).toBe(true);
  });
  it('limit 0 = off', () => {
    const b = new RollingByteBudget(() => 0);
    b.consume('ip', 1e12);
    expect(b.allows('ip', 1e12)).toBe(true);
  });
});

describe('DesignerUploadAdmission', () => {
  it('per-IP daily bytes → 429 DESIGNER_UPLOAD_QUOTA (scope ip)', async () => {
    const { admission } = build({
      DESIGNER_UPLOAD_DAILY_BYTES_PER_IP: String(10 * MB),
    });
    await expect(
      admission.admit({ ip: '1.1.1.1', bytes: 5 * MB }),
    ).resolves.toBeUndefined();
    admission.record({ ip: '1.1.1.1', bytes: 8 * MB });
    const err = await admission
      .admit({ ip: '1.1.1.1', bytes: 5 * MB })
      .catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'DESIGNER_UPLOAD_QUOTA',
      params: { scope: 'ip' },
    });
    // Another client is unaffected.
    await expect(
      admission.admit({ ip: '2.2.2.2', bytes: 5 * MB }),
    ).resolves.toBeUndefined();
  });

  it('per-store daily bytes (scope store)', async () => {
    const { admission } = build({
      DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE: String(10 * MB),
    });
    admission.record({ ip: 'a', storeId: 's1', bytes: 10 * MB });
    const err = (await admission
      .admit({ ip: 'b', storeId: 's1', bytes: 1 })
      .catch((e: HttpException) => e)) as HttpException;
    expect(err.getResponse()).toMatchObject({ params: { scope: 'store' } });
    await expect(
      admission.admit({ ip: 'b', storeId: 's2', bytes: 1 }),
    ).resolves.toBeUndefined();
  });

  it('max photos per design (default 10, scope design)', async () => {
    const full = build({}, 10);
    const err = (await full.admission
      .admit({ designId: DESIGN })
      .catch((e: HttpException) => e)) as HttpException;
    expect(err.getResponse()).toMatchObject({
      code: 'DESIGNER_UPLOAD_QUOTA',
      params: { scope: 'design', max_photos: 10 },
    });
    expect(full.prisma.designAsset.count).toHaveBeenCalledWith({
      where: { design_id: DESIGN, kind: 'CUSTOMER_PHOTO', purged_at: null },
    });
    await expect(
      build({}, 9).admission.admit({ designId: DESIGN }),
    ).resolves.toBeUndefined();
    // A malformed id never reaches the database.
    const b = build({}, 99);
    await b.admission.admit({ designId: 'nope' });
    expect(b.prisma.designAsset.count).not.toHaveBeenCalled();
  });

  it('low disk → 503 DESIGNER_STORAGE_FULL', async () => {
    const { admission } = build({
      DESIGNER_UPLOAD_MIN_FREE_MB: String(Number.MAX_SAFE_INTEGER / MB),
    });
    const err = await admission
      .admit({ storageRoot: __dirname })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(designerErrorCode(err)).toBe('DESIGNER_STORAGE_FULL');
  });
});

describe('DesignerPhotoAdmissionInterceptor', () => {
  const ctx = (req: Record<string, unknown>) =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;

  it('refuses before the handler (multer) runs and charges stored bytes after', async () => {
    const { admission } = build({
      DESIGNER_UPLOAD_DAILY_BYTES_PER_IP: String(10 * MB),
    });
    const interceptor = new DesignerPhotoAdmissionInterceptor(admission);
    const req: Record<string, unknown> = {
      ip: '9.9.9.9',
      appStoreId: 's1',
      params: { id: DESIGN },
      headers: { 'content-length': String(4 * MB) },
    };
    const handle = jest.fn(() => {
      req.file = { size: 7 * MB };
      return of('ok');
    });
    await expect(
      lastValueFrom(interceptor.intercept(ctx(req), { handle })),
    ).resolves.toBe('ok');
    expect(admission.perIp.allows('9.9.9.9', 4 * MB)).toBe(false);
    const handle2 = jest.fn(() => of('never'));
    expect(
      await code(
        lastValueFrom(interceptor.intercept(ctx(req), { handle: handle2 })),
      ),
    ).toBe('DESIGNER_UPLOAD_QUOTA');
    expect(handle2).not.toHaveBeenCalled();
  });
});
