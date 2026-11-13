import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import express from 'express';
import { promises as fs } from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import request from 'supertest';
import { mockS3, type MockS3 } from './__fixtures__/s3-mock';
import { PublicStorage } from './public-storage';
import { S3ObjectStorage } from './s3-object-storage';
import {
  createUploadsServingHandler,
  parseRangeHeader,
  uploadsPathToKey,
} from './uploads-serving';

describe('uploads serving handler (s3 mode)', () => {
  let root: string;
  let app: express.Express;
  let storage: PublicStorage;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-'));
    storage = PublicStorage.local(root);
    await storage.put('products', 'a.webp', Buffer.from('WEBPDATA'));
    await storage.put(
      'logos',
      'l.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );
    await storage.put('customer-previews', 'c.webp', Buffer.from('PREVIEW'));
    await storage.put('template-imports/store-1', 'k.png', Buffer.from('PNG'));
    app = express();
    app.use('/uploads', createUploadsServingHandler(storage));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
  });
  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  it('streams the object with the immutable cache headers, ETag and Last-Modified', async () => {
    const res = await request(app).get('/uploads/products/a.webp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['content-length']).toBe('8');
    expect(res.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.headers['etag']).toMatch(/^".+"$/);
    expect(res.headers['last-modified']).toMatch(/GMT$/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(res.body.toString()).toBe('WEBPDATA');
  });

  it('forces a download for SVG', async () => {
    const res = await request(app).get('/uploads/logos/l.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-disposition']).toBe('attachment');
  });

  it('customer previews: one-day cache and noindex', async () => {
    const res = await request(app).get('/uploads/customer-previews/c.webp');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it('serves template-imports/<store>/<file>', async () => {
    const res = await request(app).get(
      '/uploads/template-imports/store-1/k.png',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('answers 304 to If-None-Match / If-Modified-Since', async () => {
    const first = await request(app).get('/uploads/products/a.webp');
    const etag = first.headers['etag'];
    const r304 = await request(app)
      .get('/uploads/products/a.webp')
      .set('If-None-Match', etag);
    expect(r304.status).toBe(304);
    expect(r304.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    const rIms = await request(app)
      .get('/uploads/products/a.webp')
      .set('If-Modified-Since', first.headers['last-modified']);
    expect(rIms.status).toBe(304);
    const stale = await request(app)
      .get('/uploads/products/a.webp')
      .set('If-None-Match', '"other"');
    expect(stale.status).toBe(200);
  });

  it('HEAD answers the headers without a body (no object read)', async () => {
    const getSpy = jest.spyOn(storage, 'getForServing');
    const res = await request(app).head('/uploads/products/a.webp');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('8');
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(res.headers['etag']).toMatch(/^".+"$/);
    expect(res.text ?? '').toBe('');
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
    expect(
      (await request(app).head('/uploads/products/missing.webp')).status,
    ).toBe(404);
  });

  it('404s a missing object, traversal and other shapes without reading', async () => {
    const spy = jest.spyOn(storage, 'getForServing');
    expect(
      (await request(app).get('/uploads/products/missing.webp')).status,
    ).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    // (`a\b` is normalised to `a/b` by the HTTP client; see uploadsPathToKey.)
    for (const p of [
      '/uploads/../package.json',
      '/uploads/%2e%2e/package.json',
      '/uploads/products/..%2fx.webp',
      '/uploads/products/a.webp/extra/too/deep',
      '/uploads/products',
      '/uploads/products/',
      '/uploads/products/noext',
      '/uploads/products/a%00.webp',
    ]) {
      const res = await request(app).get(p);
      expect([404]).toContain(res.status);
      expect(spy.mock.calls.map((c) => `${p} -> ${c[0]}`)).toEqual([]);
    }
    spy.mockRestore();
  });

  it('other methods fall through', async () => {
    const res = await request(app).post('/uploads/products/a.webp');
    expect(res.status).toBe(404);
  });

  it('maps paths to keys', () => {
    expect(uploadsPathToKey('/products/a.webp')).toBe(
      'uploads/products/a.webp',
    );
    expect(uploadsPathToKey('/products/a.webp?x=1')).toBe(
      'uploads/products/a.webp',
    );
    expect(uploadsPathToKey('/template-imports/s/k.png')).toBe(
      'uploads/template-imports/s/k.png',
    );
    expect(uploadsPathToKey('/a/b/c/d.png')).toBeNull();
    expect(uploadsPathToKey('/../x.png')).toBeNull();
    expect(uploadsPathToKey('/products/%2e%2e/x.png')).toBeNull();
    expect(uploadsPathToKey('/products/a%2Fb.png')).toBeNull();
    expect(uploadsPathToKey('/products/%zz.png')).toBeNull();
  });

  it('parses single byte ranges and ignores everything else', () => {
    expect(parseRangeHeader('bytes=0-99')).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-')).toEqual({ start: 100 });
    expect(parseRangeHeader('bytes=-500')).toEqual({ suffix: 500 });
    expect(parseRangeHeader('Bytes = 1 - 2')).toEqual({ start: 1, end: 2 });
    for (const h of [
      undefined,
      '',
      'bytes=',
      'bytes=-',
      'bytes=5-2',
      'bytes=0-1,3-4',
      'items=0-1',
      'bytes=1.5-2',
      'bytes=99999999999999999999-',
    ]) {
      expect(parseRangeHeader(h)).toBeNull();
    }
  });
});

/** Buffers any response body (supertest leaves video/* unparsed). */
function binary(
  res: request.Response,
  cb: (err: Error | null, body: unknown) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe.each(['local', 's3'] as const)(
  'uploads serving: byte ranges (%s driver)',
  (driver) => {
    let root: string;
    let s3: MockS3 | null = null;
    let storage: PublicStorage;
    let app: express.Express;
    const VIDEO = '/uploads/products/v.mp4';

    beforeAll(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-range-'));
      if (driver === 's3') {
        s3 = mockS3(['media']);
        storage = new PublicStorage(
          new S3ObjectStorage({
            client: s3.client,
            bucket: 'media',
            role: 'media',
          }),
        );
      } else {
        storage = PublicStorage.local(root);
      }
      await storage.put('products', 'v.mp4', Buffer.from('0123456789'), {
        contentType: 'video/mp4',
      });
      await storage.put('products', 'a.webp', Buffer.from('WEBPDATA'));
      await storage.put('logos', 'l.svg', Buffer.from('<svg/>'));
      app = express();
      app.use('/uploads', createUploadsServingHandler(storage));
    });
    afterAll(async () => {
      s3?.stub.restore();
      await fs.rm(root, { recursive: true, force: true });
    });

    const get = (p: string, headers: Record<string, string> = {}) => {
      let r = request(app).get(p).buffer(true).parse(binary);
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r;
    };

    it('full GET: 200 with Accept-Ranges: bytes and the whole body', async () => {
      const res = await get(VIDEO);
      expect(res.status).toBe(200);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe('10');
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['content-range']).toBeUndefined();
      expect((res.body as Buffer).toString()).toBe('0123456789');
    });

    it.each([
      ['bytes=2-4', '2-4', '234'],
      ['bytes=7-', '7-9', '789'],
      ['bytes=-3', '7-9', '789'],
      ['bytes=8-100', '8-9', '89'],
      ['bytes=-50', '0-9', '0123456789'],
      ['bytes=0-0', '0-0', '0'],
    ])('%s -> 206 %s', async (range, span, text) => {
      const res = await get(VIDEO, { Range: range });
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes ${span}/10`);
      expect(res.headers['content-length']).toBe(String(text.length));
      expect((res.body as Buffer).toString()).toBe(text);
      // Cache and security headers are the same as on a 200.
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['etag']).toMatch(/^".+"$/);
      expect(res.headers['last-modified']).toMatch(/GMT$/);
    });

    if (driver === 's3') {
      it('a plain GET is exactly one GetObject (no Range, no HeadObject)', async () => {
        s3!.stub.resetHistory();
        const res = await get(VIDEO);
        expect(res.status).toBe(200);
        const calls = s3!.stub.commandCalls(GetObjectCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.Range).toBeUndefined();
        expect(s3!.stub.commandCalls(HeadObjectCommand)).toHaveLength(0);
      });

      it('sends exactly one ranged GetObject (never the whole object)', async () => {
        s3!.stub.resetHistory();
        await get(VIDEO, { Range: 'bytes=7-' });
        const calls = s3!.stub.commandCalls(GetObjectCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.Range).toBe('bytes=7-');
      });
    }

    it.each(['bytes=10-', 'bytes=999-1000', 'bytes=-0'])(
      '%s -> 416 with Content-Range: bytes */10',
      async (range) => {
        const res = await get(VIDEO, { Range: range });
        expect(res.status).toBe(416);
        expect(res.headers['content-range']).toBe('bytes */10');
        expect(res.headers['cache-control']).toBe('no-store');
        expect((res.body as Buffer).length).toBe(0);
      },
    );

    it.each([
      'bytes=0-1,4-5',
      'bytes=5-2',
      'items=0-1',
      'bytes=abc',
      'bytes=-',
      'bytes=99999999999999999999-',
    ])('ignored Range %s -> full 200', async (range) => {
      const res = await get(VIDEO, { Range: range });
      expect(res.status).toBe(200);
      expect(res.headers['content-range']).toBeUndefined();
      expect((res.body as Buffer).toString()).toBe('0123456789');
    });

    it('HEAD: headers only, with and without a range', async () => {
      const full = await request(app).head(VIDEO);
      expect(full.status).toBe(200);
      expect(full.headers['content-length']).toBe('10');
      expect(full.headers['accept-ranges']).toBe('bytes');
      const part = await request(app).head(VIDEO).set('Range', 'bytes=2-4');
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 2-4/10');
      expect(part.headers['content-length']).toBe('3');
      expect(part.text ?? '').toBe('');
      const bad = await request(app).head(VIDEO).set('Range', 'bytes=10-');
      expect(bad.status).toBe(416);
      expect(bad.headers['content-range']).toBe('bytes */10');
    });

    it('If-None-Match still answers 304, also with a Range', async () => {
      const etag = (await request(app).head(VIDEO)).headers['etag'];
      const r304 = await get(VIDEO, { 'If-None-Match': etag });
      expect(r304.status).toBe(304);
      expect(r304.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      const ranged = await get(VIDEO, {
        'If-None-Match': etag,
        Range: 'bytes=0-1',
      });
      expect(ranged.status).toBe(304);
      const stale = await get(VIDEO, {
        'If-None-Match': '"other"',
        Range: 'bytes=0-1',
      });
      expect(stale.status).toBe(206);
    });

    it('If-Range: a matching validator keeps the range, a stale one sends 200', async () => {
      const head = await request(app).head(VIDEO);
      const match = await get(VIDEO, {
        Range: 'bytes=0-1',
        'If-Range': head.headers['etag'],
      });
      expect(match.status).toBe(206);
      expect((match.body as Buffer).toString()).toBe('01');
      const byDate = await get(VIDEO, {
        Range: 'bytes=0-1',
        'If-Range': head.headers['last-modified'],
      });
      expect(byDate.status).toBe(206);
      for (const stale of [
        '"other"',
        'W/"x"',
        'Wed, 01 Jan 2020 00:00:00 GMT',
      ]) {
        const res = await get(VIDEO, { Range: 'bytes=0-1', 'If-Range': stale });
        expect(res.status).toBe(200);
        expect((res.body as Buffer).toString()).toBe('0123456789');
      }
      const staleOutOfRange = await get(VIDEO, {
        Range: 'bytes=50-',
        'If-Range': '"other"',
      });
      expect(staleOutOfRange.status).toBe(200);
      expect((staleOutOfRange.body as Buffer).toString()).toBe('0123456789');
    });

    it('non-video files: unchanged full GET; ranges work the same way', async () => {
      const img = await get('/uploads/products/a.webp');
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toBe('image/webp');
      expect(img.headers['content-length']).toBe('8');
      expect((img.body as Buffer).toString()).toBe('WEBPDATA');
      const svg = await get('/uploads/logos/l.svg', { Range: 'bytes=0-1' });
      expect(svg.status).toBe(206);
      expect(svg.headers['content-disposition']).toBe('attachment');
      expect(svg.headers['x-content-type-options']).toBe('nosniff');
      expect((svg.body as Buffer).toString()).toBe('<s');
    });
  },
);

describe('uploads serving: aborted clients and stream errors', () => {
  let server: http.Server;
  let port: number;
  let getForServing: jest.Mock;

  const meta = {
    size: 1_000_000,
    etag: '"x"',
    lastModified: new Date('2026-11-01T00:00:00Z'),
    contentType: 'video/mp4',
    metadata: {},
  };

  beforeEach(async () => {
    getForServing = jest.fn();
    const fake = {
      getForServing,
      headForServing: jest.fn(() => Promise.resolve(meta)),
    } as unknown as PublicStorage;
    const app = express();
    app.use('/uploads', createUploadsServingHandler(fake));
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const destroyed = (s: Readable) =>
    new Promise<void>((resolve, reject) => {
      if (s.destroyed) return resolve();
      const t = setTimeout(
        () => reject(new Error('stream not destroyed')),
        2000,
      );
      s.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });

  /** An endless body that produces one chunk per read. */
  const endless = () =>
    new Readable({
      read() {
        setTimeout(() => this.push(Buffer.alloc(1024, 1)), 5);
      },
    });

  it('destroys the storage stream when the client disconnects mid-body', async () => {
    const stream = endless();
    getForServing.mockResolvedValue({
      ...meta,
      stream,
      range: { start: 0, end: meta.size - 1 },
    });
    await new Promise<void>((resolve) => {
      const req = http.get(
        {
          port,
          path: '/uploads/products/v.mp4',
          headers: { Range: 'bytes=0-' },
        },
        (res) => {
          expect(res.statusCode).toBe(206);
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
    });
    await destroyed(stream);
    expect(stream.destroyed).toBe(true);
  });

  it('destroys the stream when the client left before the read resolved', async () => {
    const stream = endless();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const called = new Promise<void>((r) => (started = r));
    getForServing.mockImplementation(async () => {
      started();
      await gate;
      return { ...meta, stream };
    });
    const req = http.get({ port, path: '/uploads/products/v.mp4' });
    req.on('error', () => undefined);
    await called;
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await destroyed(stream);
    expect(stream.destroyed).toBe(true);
  });

  it('a stream error before any byte answers 502; after the headers it drops the connection', async () => {
    getForServing.mockResolvedValueOnce({
      ...meta,
      stream: new Readable({
        read() {
          this.destroy(new Error('s3 reset'));
        },
      }),
    });
    const early = await request(server).get('/uploads/products/v.mp4');
    expect(early.status).toBe(502);
    expect(early.headers['content-length']).not.toBe(String(meta.size));
    // Never cacheable by a CDN under the immutable rule.
    expect(early.headers['cache-control']).toBe('no-store');
    expect(early.headers['etag']).toBeUndefined();

    let n = 0;
    getForServing.mockResolvedValueOnce({
      ...meta,
      stream: new Readable({
        read() {
          if (n++ === 0) this.push(Buffer.alloc(1024, 1));
          else setTimeout(() => this.destroy(new Error('s3 reset')), 5);
        },
      }),
    });
    const late = await new Promise<string>((resolve) => {
      const req = http.get({ port, path: '/uploads/products/v.mp4' }, (res) => {
        expect(res.statusCode).toBe(200);
        res.on('data', () => undefined);
        res.on('end', () => resolve('end'));
        res.on('aborted', () => resolve('aborted'));
        res.on('error', () => resolve('aborted'));
      });
      req.on('error', () => resolve('aborted'));
    });
    expect(late).toBe('aborted');

    // The process keeps serving.
    getForServing.mockResolvedValueOnce({
      ...meta,
      size: 2,
      stream: Readable.from([Buffer.from('ok')]),
    });
    const after = await request(server)
      .get('/uploads/products/v.mp4')
      .buffer(true)
      .parse(binary);
    expect(after.status).toBe(200);
    expect((after.body as Buffer).toString()).toBe('ok');
  });
});
