import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { PublicStorage } from '../storage/public-storage';
import { emailSafeLogoPath, resetEmailLogoCache } from './order-mail.helpers';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#f00"/></svg>`;

describe('emailSafeLogoPath (PublicStorage)', () => {
  let root: string;
  let storage: PublicStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'email-logo-'));
    storage = PublicStorage.local(root);
    resetEmailLogoCache();
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('renders <logo>.email.png next to an SVG through the storage and caches by key', async () => {
    await storage.put('logos', 'l.svg', Buffer.from(SVG));
    const out = await emailSafeLogoPath('/uploads/logos/l.svg', storage);
    expect(out).toBe('/uploads/logos/l.email.png');
    const png = await storage.read(out);
    expect(png).not.toBeNull();
    const meta = await sharp(png!).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(480);

    const put = jest.spyOn(storage, 'put');
    const exists = jest.spyOn(storage, 'exists');
    expect(await emailSafeLogoPath('/uploads/logos/l.svg', storage)).toBe(out);
    expect(put).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it('reuses an existing rendition without re-rendering', async () => {
    await storage.put('logos', 'l.svg', Buffer.from(SVG));
    await storage.put('logos', 'l.email.png', Buffer.from('PNG'));
    const put = jest.spyOn(storage, 'put');
    expect(await emailSafeLogoPath('/uploads/logos/l.svg', storage)).toBe(
      '/uploads/logos/l.email.png',
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('leaves non-SVG, absolute, missing and unsafe paths unchanged', async () => {
    expect(await emailSafeLogoPath('/uploads/logos/l.png', storage)).toBe(
      '/uploads/logos/l.png',
    );
    expect(
      await emailSafeLogoPath('https://x/uploads/logos/l.svg', storage),
    ).toBe('https://x/uploads/logos/l.svg');
    expect(await emailSafeLogoPath('/uploads/logos/missing.svg', storage)).toBe(
      '/uploads/logos/missing.svg',
    );
    expect(await emailSafeLogoPath('/uploads/../x.svg', storage)).toBe(
      '/uploads/../x.svg',
    );
    expect(await emailSafeLogoPath('/etc/x.svg', storage)).toBe('/etc/x.svg');
    expect(await fs.readdir(root)).toEqual([]);
  });
});
