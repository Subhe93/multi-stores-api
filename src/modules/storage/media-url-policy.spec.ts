/**
 * Guards the serving policy of the S3 project: public media is reachable
 * ONLY through the API's `/uploads/*` streaming handler. No code builds a
 * direct `https://<bucket>.s3…amazonaws.com/…` URL or a presigned URL, the
 * media base URL defaults to the API origin, and the handler reads from the
 * storage abstraction (so Block Public Access on the bucket is fine).
 */
import express from 'express';
import { promises as fs } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { parseStorageConfig } from './storage.config';
import { buildObjectStorages } from './storage.module';
import { PublicStorage } from './public-storage';
import { createUploadsServingHandler } from './uploads-serving';
import { S3ObjectStorage } from './s3-object-storage';
import { mockS3 } from './__fixtures__/s3-mock';

const SRC = path.resolve(__dirname, '..', '..');
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'direct S3 host', re: /amazonaws\.com/ },
  { name: 'virtual-hosted bucket URL', re: /\.s3[.-][a-z0-9-]*\.?amazonaws/ },
  { name: 'presigned URL', re: /getSignedUrl|presign/i },
  { name: 's3-request-presigner', re: /@aws-sdk\/s3-request-presigner/ },
];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      yield* walk(full);
    } else if (
      ent.isFile() &&
      ent.name.endsWith('.ts') &&
      !ent.name.endsWith('.spec.ts')
    ) {
      yield full;
    }
  }
}

describe('media URL policy (s3 mode)', () => {
  it('no source file builds a direct S3 URL or a presigned URL', async () => {
    const hits: string[] = [];
    for await (const file of walk(SRC)) {
      const text = await fs.readFile(file, 'utf8');
      for (const f of FORBIDDEN) {
        if (f.re.test(text)) {
          hits.push(`${path.relative(SRC, file)}: ${f.name}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('MEDIA_BASE_URL defaults to the API origin and absolute URLs stay on it', () => {
    const cfg = parseStorageConfig(
      {
        STORAGE_DRIVER: 's3',
        AWS_REGION: 'us-east-1',
        S3_MEDIA_BUCKET: 'one',
        S3_PRIVATE_BUCKET: 'one',
        PUBLIC_API_URL: 'https://api.example.com/',
      },
      process.cwd(),
    );
    expect(cfg.mediaBaseUrl).toBe('https://api.example.com');
    const s3 = mockS3(['one']);
    const pub = new PublicStorage(
      buildObjectStorages(cfg, s3.client).media,
      cfg,
    );
    expect(pub.absoluteUrl('/uploads/products/a.webp')).toBe(
      'https://api.example.com/uploads/products/a.webp',
    );
    expect(pub.urlFor('uploads/products/a.webp')).toBe(
      '/uploads/products/a.webp',
    );
    s3.stub.restore();
  });

  it('the /uploads handler streams the object from the media role (prefixed key) with the API headers', async () => {
    const s3 = mockS3(['one']);
    const media = new S3ObjectStorage({
      client: s3.client,
      bucket: 'one',
      role: 'media',
      keyPrefix: 'media/',
    });
    const pub = new PublicStorage(media);
    const put = await pub.put('products', 'a.webp', Buffer.from('img'));
    expect(put.url).toBe('/uploads/products/a.webp');
    expect(s3.objects.has('one/media/uploads/products/a.webp')).toBe(true);

    const app = express();
    app.use('/uploads', createUploadsServingHandler(pub));
    const res = await request(app).get('/uploads/products/a.webp');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.body.toString()).toBe('img');
    expect(s3.calls).toContain('GetObject');
    // Nothing else is reachable through the handler (no bucket listing, no
    // other role's objects).
    expect((await request(app).get('/uploads/../private/x')).status).toBe(404);
    s3.stub.restore();
  });
});
