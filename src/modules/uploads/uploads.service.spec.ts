import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { UploadsService } from './uploads.service';

describe('UploadsService.storeBuffer (C21 refactor)', () => {
  let cwd: string;
  let service: UploadsService;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'uploads-svc-'));
    jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    service = new UploadsService();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const file = (name: string, buffer: Buffer) =>
    ({
      originalname: name,
      buffer,
      size: buffer.length,
    }) as Express.Multer.File;

  it('uploadFile still re-encodes rasters to WebP ≤ 2000px', async () => {
    const jpg = await sharp({
      create: {
        width: 3000,
        height: 1500,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg()
      .toBuffer();
    const res = await service.uploadFile(file('a.JPG', jpg), 'products');
    expect(res.url).toMatch(/^\/uploads\/products\/[0-9a-f-]{36}\.webp$/);
    expect(res.file_type).toBe('webp');
    const out = await fs.readFile(path.join(cwd, res.url));
    expect(res.file_size).toBe(out.length);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1000);
  });

  it('uploadFile passes documents through byte-identical', async () => {
    const pdf = Buffer.from('%PDF-1.7 hello');
    const res = await service.uploadFile(file('doc.pdf', pdf), '../../etc');
    expect(res.url).toMatch(/^\/uploads\/\.\.\.\.etc\/[0-9a-f-]{36}\.pdf$/);
    expect(res).toMatchObject({ file_type: 'pdf', file_size: pdf.length });
    expect(await fs.readFile(path.join(cwd, res.url))).toEqual(pdf);
  });

  it('uploadFile keeps its validation errors', async () => {
    await expect(
      service.uploadFile(undefined as unknown as Express.Multer.File),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NO_FILE' } });
    await expect(
      service.uploadFile(file('x.exe', Buffer.from('MZ'))),
    ).rejects.toThrow('File type .exe not allowed');
  });

  it('storeBuffer honours a fixed uuid file name and rejects other names', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#00ff00' },
    })
      .png()
      .toBuffer();
    const res = await service.storeBuffer(png, 'png', 'customer-previews', {
      id,
    });
    expect(res.url).toBe(`/uploads/customer-previews/${id}.webp`);
    await expect(
      service.storeBuffer(png, '.png', 'x', { id: '../evil' }),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_INVALID_PATH' } });
  });

  it('default decoder options are unchanged (existing uploads stay byte-identical)', async () => {
    const webp = await sharp({
      create: { width: 50, height: 40, channels: 3, background: '#123456' },
    })
      .webp()
      .toBuffer();
    const res = await service.storeBuffer(webp, '.webp', 'products');
    const stored = await fs.readFile(path.join(cwd, res.url));
    // The pre-M4.0 pipeline, verbatim.
    const legacy = await sharp(webp, { animated: true })
      .rotate()
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    expect(stored.equals(legacy)).toBe(true);
  });

  it('customer previews decode under an explicit pixel cap', async () => {
    const webp = await sharp({
      create: { width: 20, height: 10, channels: 3, background: '#ff0000' },
    })
      .webp()
      .toBuffer();
    const ok = await service.storeBuffer(webp, '.webp', 'customer-previews', {
      animated: false,
      limitInputPixels: 200,
    });
    const meta = await sharp(
      await fs.readFile(path.join(cwd, ok.url)),
    ).metadata();
    expect([meta.width, meta.height, meta.pages ?? 1]).toEqual([20, 10, 1]);
    await expect(
      service.storeBuffer(webp, '.webp', 'customer-previews', {
        animated: false,
        limitInputPixels: 199,
      }),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_IMAGE_PROCESS_FAILED' },
    });
  });
});
