import express from 'express';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { PublicStorage } from './public-storage';
import {
  createUploadsServingHandler,
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

  it('HEAD answers the headers without a body', async () => {
    const res = await request(app).head('/uploads/products/a.webp');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('8');
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.text ?? '').toBe('');
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
});
