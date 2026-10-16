import sharp from 'sharp';
import { inspectRaster, RasterInspectError } from './raster-inspect';

function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof RasterInspectError ? e.code : 'OTHER';
  }
}

describe('inspectRaster', () => {
  it('returns format and size', async () => {
    await expect(
      inspectRaster(await png(40, 30), { maxPixels: 10_000 }),
    ).resolves.toEqual({ format: 'png', width: 40, height: 30, pages: 1 });
  });

  it('rejects undecodable bytes', async () => {
    expect(
      await codeOf(inspectRaster(Buffer.from('nope'), { maxPixels: 1e6 })),
    ).toBe('RASTER_UNDECODABLE');
  });

  it('rejects formats outside the allow list (SVG, GIF)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
    expect(await codeOf(inspectRaster(svg, { maxPixels: 1e6 }))).toBe(
      'RASTER_FORMAT_NOT_ALLOWED',
    );
    const gif = await sharp(await png(4, 4))
      .gif()
      .toBuffer();
    expect(await codeOf(inspectRaster(gif, { maxPixels: 1e6 }))).toBe(
      'RASTER_FORMAT_NOT_ALLOWED',
    );
  });

  it('applies the pixel and side limits', async () => {
    const img = await png(100, 50);
    expect(await codeOf(inspectRaster(img, { maxPixels: 4999 }))).toBe(
      'RASTER_TOO_MANY_PIXELS',
    );
    expect(
      await codeOf(inspectRaster(img, { maxPixels: 1e6, maxSide: 99 })),
    ).toBe('RASTER_TOO_LARGE');
    expect(
      await codeOf(inspectRaster(img, { maxPixels: 1e6, minShortSide: 51 })),
    ).toBe('RASTER_TOO_SMALL');
    expect(
      await codeOf(
        inspectRaster(img, { maxPixels: 5000, maxSide: 100, minShortSide: 50 }),
      ),
    ).toBeUndefined();
  });
});
