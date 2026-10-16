import { PassThrough } from 'stream';
import type { Request } from 'express';
import {
  BUNDLE_DIR_ROOT_ENV,
  boundedBundleStorage,
  isRelativeBundleDirName,
  readBundleDirectory,
} from './bundle-store';

// M4.4 fixer B: the 50 MB bundle total is enforced while streaming, and the
// admin directory input is a relative name checked before any realpath.

type Result = { err: unknown; info?: { buffer?: Buffer; size?: number } };

function upload(
  storage: ReturnType<typeof boundedBundleStorage>,
  req: Request,
  chunks: Buffer[],
): Promise<Result> {
  return new Promise((resolve) => {
    const stream = new PassThrough();
    storage._handleFile(
      req,
      { stream } as unknown as Express.Multer.File,
      (err, info) => resolve({ err, info: info as Result['info'] }),
    );
    for (const c of chunks) stream.write(c);
    stream.end();
  });
}

describe('boundedBundleStorage', () => {
  it('buffers files like memoryStorage while under the total', async () => {
    const storage = boundedBundleStorage(10);
    const req = {} as Request;
    const a = await upload(storage, req, [
      Buffer.from('abc'),
      Buffer.from('de'),
    ]);
    expect(a.err).toBeNull();
    expect(a.info?.buffer?.toString()).toBe('abcde');
    expect(a.info?.size).toBe(5);
    const b = await upload(storage, req, [Buffer.from('fghij')]);
    expect(b.err).toBeNull();
    expect(b.info?.size).toBe(5);
  });

  it('aborts with 413 IMPORT_BUNDLE_TOO_LARGE once the request total is exceeded', async () => {
    const storage = boundedBundleStorage(10);
    const req = {} as Request;
    await upload(storage, req, [Buffer.alloc(6)]);
    const second = await upload(storage, req, [
      Buffer.alloc(3),
      Buffer.alloc(3),
    ]);
    expect(second.err).toMatchObject({
      status: 413,
      response: { code: 'IMPORT_BUNDLE_TOO_LARGE' },
    });
    expect(second.info).toBeUndefined();
  });

  it('counts per request, not per process', async () => {
    const storage = boundedBundleStorage(10);
    expect(
      (await upload(storage, {} as Request, [Buffer.alloc(8)])).err,
    ).toBeNull();
    expect(
      (await upload(storage, {} as Request, [Buffer.alloc(8)])).err,
    ).toBeNull();
  });

  it('_removeFile drops the buffer', (done) => {
    const file = { buffer: Buffer.alloc(1) } as Express.Multer.File;
    boundedBundleStorage()._removeFile({} as Request, file, (err) => {
      expect(err).toBeNull();
      expect(file.buffer).toBeUndefined();
      done();
    });
  });
});

describe('admin bundle directory name', () => {
  it.each(['namez', 'namez/2026-10-15', 'a.b_c-d/e', 'x/.y'])(
    'accepts the relative name %s',
    (d) => expect(isRelativeBundleDirName(d)).toBe(true),
  );

  it.each([
    '/etc',
    '/srv/bundles/namez',
    'C:\\bundles',
    'C:/bundles',
    '\\\\host\\share',
    '//host/share',
    '..',
    '../x',
    'a/../../x',
    'a/..',
    'a b',
    'a\\b',
    '',
  ])('rejects %s', (d) => expect(isRelativeBundleDirName(d)).toBe(false));

  it('readBundleDirectory refuses absolute input before touching the disk', async () => {
    const prev = process.env[BUNDLE_DIR_ROOT_ENV];
    process.env[BUNDLE_DIR_ROOT_ENV] = process.cwd();
    try {
      await expect(readBundleDirectory(process.cwd())).rejects.toMatchObject({
        response: { code: 'IMPORT_BUNDLE_MISSING_FILE' },
      });
    } finally {
      if (prev === undefined) delete process.env[BUNDLE_DIR_ROOT_ENV];
      else process.env[BUNDLE_DIR_ROOT_ENV] = prev;
    }
  });
});

describe('boundedBundleStorage behind multer (HTTP)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require('express') as typeof import('express');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const multer = require('multer') as typeof import('multer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const request = require('supertest') as typeof import('supertest');

  function app(total: number, perFile: number) {
    const a = express();
    a.post(
      '/up',
      multer({
        storage: boundedBundleStorage(total),
        limits: { fileSize: perFile, files: 4 },
      }).fields([{ name: 'files', maxCount: 4 }]),
      (req, res) => {
        const files = (req.files as Record<string, Express.Multer.File[]>)
          .files;
        res.json({ sizes: files.map((f) => f.size) });
      },
    );
    a.use(
      (
        err: { status?: number; response?: { code?: string }; code?: string },
        _req: unknown,
        res: import('express').Response,
        _next: unknown,
      ) => {
        void _next;
        res
          .status(err.status ?? 400)
          .json({ code: err.response?.code ?? err.code });
      },
    );
    return a;
  }

  it('accepts files whose total stays under the cap', async () => {
    const res = await request(app(100, 80))
      .post('/up')
      .attach('files', Buffer.alloc(40), 'posts.tsv')
      .attach('files', Buffer.alloc(40), 'postmeta.tsv');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sizes: [40, 40] });
  });

  it('answers 413 IMPORT_BUNDLE_TOO_LARGE when the files together exceed it', async () => {
    const res = await request(app(100, 80))
      .post('/up')
      .attach('files', Buffer.alloc(60), 'posts.tsv')
      .attach('files', Buffer.alloc(60), 'postmeta.tsv');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ code: 'IMPORT_BUNDLE_TOO_LARGE' });
  });

  it('still applies the per-file limit', async () => {
    const res = await request(app(1000, 50))
      .post('/up')
      .attach('files', Buffer.alloc(60), 'posts.tsv');
    expect(res.body).toEqual({ code: 'LIMIT_FILE_SIZE' });
  });
});
