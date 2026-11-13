import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import {
  Mp4ProbeError,
  patchChunkOffsets,
  probeMp4,
  type Mp4ProbeOptions,
} from './mp4-probe';
import { sniffUploadType } from './upload-sniff';
import { box, buildMp4, type Mp4Spec } from './__fixtures__/mp4-builder';

describe('probeMp4', () => {
  let dir: string;
  const opts: Mp4ProbeOptions = { maxSeconds: 60, maxKbps: 8000 };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp4-probe-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const write = async (buf: Buffer, name = 'in.upload') => {
    const p = path.join(dir, name);
    await fs.writeFile(p, buf);
    return p;
  };
  const probeSpec = async (spec: Mp4Spec, o: Partial<Mp4ProbeOptions> = {}) =>
    probeMp4(await write(buildMp4(spec).file), { ...opts, ...o });
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(Mp4ProbeError);
      return e as Mp4ProbeError;
    }
    throw new Error('expected the probe to fail');
  };

  it('reads duration (mvhd v0), size and codecs of a faststart H.264/AAC file', async () => {
    const r = await probeSpec({ timescale: 600, duration: 600 * 32 });
    expect(r).toMatchObject({
      seconds: 32,
      durationS: 32,
      width: 1920,
      height: 1080,
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
      faststartFixed: false,
    });
    expect(r.outputPath).toMatch(/in\.upload$/);
  });

  it('reads a v1 mvhd (64-bit duration) and rounds to at least 1 s', async () => {
    const r = await probeSpec({
      mvhdVersion: 1,
      timescale: 90000,
      duration: 90000 * 12.4,
    });
    expect(r.durationS).toBe(12);
    const short = await probeSpec({ timescale: 1000, duration: 200 });
    expect(short.durationS).toBe(1);
  });

  it('swaps width/height for a 90° rotation matrix (portrait phone video)', async () => {
    const r = await probeSpec({
      tracks: [
        {
          handler: 'vide',
          codec: 'avc1',
          width: 1920,
          height: 1080,
          rotate90: true,
        },
      ],
    });
    expect([r.width, r.height]).toEqual([1080, 1920]);
    expect(r.audioCodec).toBeNull();
  });

  it('uses mvex/mehd when a fragmented file has mvhd duration 0', async () => {
    const mehd = Buffer.alloc(8);
    mehd.writeUInt32BE(15_000, 4);
    const r = await probeSpec({
      timescale: 1000,
      duration: 0,
      compat: ['iso6', 'dash'],
      moovExtra: [box('mvex', box('mehd', mehd))],
    });
    expect(r.durationS).toBe(15);
  });

  it('rejects QuickTime (qt brand) as UPLOAD_VIDEO_TYPE quicktime', async () => {
    const e = await failure(probeSpec({ major: 'qt  ', compat: ['qt  '] }));
    expect(e.code).toBe('UPLOAD_VIDEO_TYPE');
    expect(e.details).toEqual({ reason: 'quicktime' });
  });

  it('rejects an unknown brand as not_mp4 (e.g. 3GP / HEIF)', async () => {
    const e = await failure(probeSpec({ major: 'heic', compat: ['mif1'] }));
    expect(e.details).toEqual({ reason: 'not_mp4' });
  });

  it('rejects a renamed PNG (no ftyp)', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    expect(sniffUploadType(png, '.mp4')).toBe(false);
    const e = await failure(probeMp4(await write(png), opts));
    expect(e).toMatchObject({
      code: 'UPLOAD_VIDEO_TYPE',
      details: { reason: 'not_mp4' },
    });
  });

  it('rejects HEVC (hvc1) and a non-AAC audio track with UPLOAD_VIDEO_CODEC', async () => {
    const hevc = await failure(
      probeSpec({
        tracks: [{ handler: 'vide', codec: 'hvc1', width: 10, height: 10 }],
      }),
    );
    expect(hevc).toMatchObject({
      code: 'UPLOAD_VIDEO_CODEC',
      details: { codec: 'hvc1' },
    });
    const opus = await failure(
      probeSpec({
        tracks: [
          { handler: 'vide', codec: 'avc1', width: 10, height: 10 },
          { handler: 'soun', codec: 'Opus' },
        ],
      }),
    );
    expect(opus).toMatchObject({
      code: 'UPLOAD_VIDEO_CODEC',
      details: { codec: 'Opus' },
    });
  });

  it('ignores other track kinds (timed text) but needs a video track', async () => {
    const ok = await probeSpec({
      tracks: [
        { handler: 'vide', codec: 'avc3', width: 640, height: 360 },
        { handler: 'text', codec: 'tx3g' },
      ],
    });
    expect(ok.videoCodec).toBe('avc3');
    const e = await failure(
      probeSpec({ tracks: [{ handler: 'soun', codec: 'mp4a' }] }),
    );
    expect(e.code).toBe('UPLOAD_VIDEO_UNREADABLE');
  });

  it('rejects a file without moov, a zero timescale and a truncated box', async () => {
    const noMoov = Buffer.concat([
      buildMp4().file.subarray(0, 24),
      box('mdat', Buffer.alloc(8)),
    ]);
    expect((await failure(probeMp4(await write(noMoov), opts))).code).toBe(
      'UPLOAD_VIDEO_UNREADABLE',
    );
    expect((await failure(probeSpec({ timescale: 0 }))).code).toBe(
      'UPLOAD_VIDEO_UNREADABLE',
    );
    const full = buildMp4().file;
    const cut = full.subarray(0, full.length - 10);
    expect((await failure(probeMp4(await write(cut, 'cut'), opts))).code).toBe(
      'UPLOAD_VIDEO_UNREADABLE',
    );
  });

  it('enforces the duration cap with 0.5 s tolerance', async () => {
    await expect(
      probeSpec({ timescale: 1000, duration: 60_400 }),
    ).resolves.toBeDefined();
    const e = await failure(probeSpec({ timescale: 1000, duration: 61_000 }));
    expect(e).toMatchObject({
      code: 'UPLOAD_VIDEO_TOO_LONG',
      details: { maxSeconds: 60, durationS: 61 },
    });
  });

  it('enforces the average bitrate cap above the size threshold only', async () => {
    // 64 KB in 1 s = 524 kbps (+ headers).
    const spec: Mp4Spec = {
      timescale: 1000,
      duration: 1000,
      mdatBytes: 64 * 1024,
    };
    await expect(probeSpec(spec, { maxKbps: 100 })).resolves.toBeDefined();
    const e = await failure(
      probeSpec(spec, { maxKbps: 100, bitrateMinBytes: 1024 }),
    );
    expect(e.code).toBe('UPLOAD_VIDEO_BITRATE_TOO_HIGH');
    expect(e.details.maxKbps).toBe(100);
    expect(e.details.kbps).toBeGreaterThan(500);
  });

  it.each([false, true])(
    'relocates moov in front of mdat and shifts the chunk offsets (co64=%s)',
    async (useCo64) => {
      const { file, mdatBodyOffset, moovSize } = buildMp4({
        moovLast: true,
        tracks: [
          {
            handler: 'vide',
            codec: 'avc1',
            width: 720,
            height: 1280,
            offsets: [-1, -1],
            co64: useCo64,
          },
        ],
        mdatBytes: 300,
      });
      const input = await write(file);
      const r = await probeMp4(input, opts);
      expect(r.faststartFixed).toBe(true);
      expect(r.outputPath).not.toBe(input);
      const out = await fs.readFile(r.outputPath);
      expect(out.length).toBe(file.length);
      // Order: ftyp, moov, mdat.
      const ftypSize = out.readUInt32BE(0);
      expect(out.toString('latin1', ftypSize + 4, ftypSize + 8)).toBe('moov');
      const moovOut = out.readUInt32BE(ftypSize);
      expect(moovOut).toBe(moovSize);
      expect(
        out.toString('latin1', ftypSize + moovOut + 4, ftypSize + moovOut + 8),
      ).toBe('mdat');
      // Every chunk offset moved by moov.size and still points at the same bytes.
      const table = useCo64 ? 'co64' : 'stco';
      const at = out.indexOf(table, ftypSize, 'latin1');
      const first = useCo64
        ? Number(out.readBigUInt64BE(at + 4 + 8))
        : out.readUInt32BE(at + 4 + 8);
      expect(first).toBe(mdatBodyOffset + moovSize);
      expect(out.subarray(first, first + 32)).toEqual(
        file.subarray(mdatBodyOffset, mdatBodyOffset + 32),
      );
      // The relocated file probes as faststart.
      const again = await probeMp4(r.outputPath, opts);
      expect(again.faststartFixed).toBe(false);
    },
  );

  it('patchChunkOffsets refuses a 32-bit overflow', () => {
    const moov = box(
      'moov',
      box(
        'trak',
        box(
          'mdia',
          box(
            'minf',
            box(
              'stbl',
              box(
                'stco',
                (() => {
                  const b = Buffer.alloc(12);
                  b.writeUInt32BE(1, 4);
                  b.writeUInt32BE(0xfffffff0, 8);
                  return b;
                })(),
              ),
            ),
          ),
        ),
      ),
    );
    expect(() => patchChunkOffsets(moov, (o) => o + 0x100)).toThrow(
      expect.objectContaining({ code: 'UPLOAD_VIDEO_NOT_FASTSTART' }),
    );
  });

  it('a compressed movie header (cmov) behind mdat is refused as NOT_FASTSTART', async () => {
    const head = buildMp4().file.subarray(0, 24); // ftyp
    const file = Buffer.concat([
      head,
      box('mdat', Buffer.alloc(16)),
      box('moov', box('cmov', Buffer.alloc(8))),
    ]);
    expect((await failure(probeMp4(await write(file), opts))).code).toBe(
      'UPLOAD_VIDEO_NOT_FASTSTART',
    );
  });
});
