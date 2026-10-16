import 'reflect-metadata';
import { PayloadTooLargeException, StreamableFile } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { lastValueFrom, throwError } from 'rxjs';
import { REQUIRE_APP_KEY, ROLES_KEY } from '../../common/decorators';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  appStoreId,
  DesignerAssetsCreatorController,
  DesignerFilesPublicController,
  designerUploadLimit,
  parsePublicFileName,
} from './designer-assets.controller';
import type { DesignerAssetsService } from './designer-assets.service';
import { designerErrorCode } from './designer-errors';
import {
  DesignerFontsCreatorController,
  DesignerFontsPublicController,
} from './designer-fonts.controller';
import type { DesignerFontsService } from './designer-fonts.service';

const ID = '11111111-1111-4111-8111-111111111111';

function fakeRes() {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': 'https://namez.se',
    'Access-Control-Allow-Credentials': 'true',
  };
  return {
    headers,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    removeHeader: (k: string) => {
      delete headers[k];
    },
  };
}

describe('designer controllers: authorization metadata', () => {
  it.each([
    ['assets', DesignerAssetsCreatorController],
    ['fonts', DesignerFontsCreatorController],
  ])('creator %s routes: JWT + CREATOR role + designer app', (_n, ctrl) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ctrl) as unknown[];
    expect(guards).toHaveLength(3);
    expect(guards).toContain(RolesGuard);
    expect(guards).toContain(RequireAppGuard);
    expect(Reflect.getMetadata(ROLES_KEY, ctrl)).toEqual([UserRole.CREATOR]);
    expect(Reflect.getMetadata(REQUIRE_APP_KEY, ctrl)).toBe('designer');
  });

  it('public file routes carry no guards (capability URLs / public bytes)', () => {
    for (const ctrl of [
      DesignerFilesPublicController,
      DesignerFontsPublicController,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, ctrl)).toBeUndefined();
    }
  });

  it('the store comes from RequireAppGuard (never from the request body)', () => {
    expect(appStoreId({ appStoreId: 'store-1' })).toBe('store-1');
    expect(() => appStoreId({})).toThrow();
  });
});

describe('designer public routes: headers', () => {
  it('font route: font mime, immutable, cross-origin, no credentials', async () => {
    const bytes = Buffer.from('wOF2-bytes');
    const fonts = {
      readPublicFont: jest.fn().mockResolvedValue({
        buffer: bytes,
        mime: 'font/woff2',
        sha256: 'abc',
      }),
    } as unknown as DesignerFontsService;
    const res = fakeRes();
    const out = await new DesignerFontsPublicController(fonts).font(
      `${ID}.woff2`,
      res as never,
    );
    expect(fonts.readPublicFont).toHaveBeenCalledWith(ID, 'woff2');
    expect(out).toBeInstanceOf(StreamableFile);
    expect(out.getHeaders()).toMatchObject({
      type: 'font/woff2',
      length: bytes.length,
    });
    expect(res.headers).toMatchObject({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      ETag: '"abc"',
    });
    expect(res.headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('signed file route: private short cache, noindex', async () => {
    const assets = {
      readSignedFile: jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('x'), mime: 'image/webp' }),
    } as unknown as DesignerAssetsService;
    const res = fakeRes();
    const out = await new DesignerFilesPublicController(assets).signedFile(
      'tok.en',
      res as never,
    );
    expect(out.getHeaders()).toMatchObject({ type: 'image/webp' });
    expect(res.headers).toMatchObject({
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
  });

  it('public asset route parses <uuid>.<ext> and 404s anything else', async () => {
    expect(parsePublicFileName(`${ID}.png`)).toEqual({ id: ID, ext: 'png' });
    for (const bad of ['x.png', `${ID}`, `../${ID}.png`, `${ID}.png/..`]) {
      expect(designerErrorCode(captured(() => parsePublicFileName(bad)))).toBe(
        'DESIGNER_FILE_NOT_FOUND',
      );
    }
  });
});

describe('designerUploadLimit', () => {
  it("turns multer's 413 into DESIGNER_UPLOAD_TOO_LARGE with max_mb", async () => {
    const Interceptor = designerUploadLimit(40 * 1024 * 1024);
    const err = await lastValueFrom(
      new Interceptor().intercept({} as never, {
        handle: () => throwError(() => new PayloadTooLargeException()),
      }),
    ).catch((e: unknown) => e);
    expect(designerErrorCode(err)).toBe('DESIGNER_UPLOAD_TOO_LARGE');
    expect((err as PayloadTooLargeException).getResponse()).toMatchObject({
      params: { max_mb: 40 },
    });
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}
