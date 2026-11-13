/**
 * Crafted MP4 box structures for the probe and upload specs. Only the boxes
 * and fields the probe reads are filled; everything else is zero.
 */

export function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

export function ftyp(major: string, compat: string[] = []): Buffer {
  const body = Buffer.alloc(8 + compat.length * 4);
  body.write(major, 0, 'latin1');
  compat.forEach((b, i) => body.write(b, 8 + i * 4, 'latin1'));
  return box('ftyp', body);
}

export function mvhd(timescale: number, duration: number, version = 0): Buffer {
  if (version === 1) {
    const b = Buffer.alloc(112);
    b[0] = 1;
    b.writeUInt32BE(timescale, 20);
    b.writeBigUInt64BE(BigInt(duration), 24);
    return box('mvhd', b);
  }
  const b = Buffer.alloc(100);
  b.writeUInt32BE(timescale, 12);
  b.writeUInt32BE(duration, 16);
  return box('mvhd', b);
}

export function tkhd(width: number, height: number, rotate90 = false): Buffer {
  const b = Buffer.alloc(84);
  const m = 40;
  if (rotate90) {
    b.writeInt32BE(0, m);
    b.writeInt32BE(0x10000, m + 4);
    b.writeInt32BE(-0x10000, m + 12);
    b.writeInt32BE(0, m + 16);
  } else {
    b.writeInt32BE(0x10000, m);
    b.writeInt32BE(0x10000, m + 16);
  }
  b.writeInt32BE(0x40000000, m + 32);
  b.writeUInt32BE(width * 65536, 76);
  b.writeUInt32BE(height * 65536, 80);
  return box('tkhd', b);
}

export function hdlr(handler: string): Buffer {
  const b = Buffer.alloc(25);
  b.write(handler, 8, 'latin1');
  return box('hdlr', b);
}

export function stsd(format: string): Buffer {
  const entry = Buffer.alloc(16);
  entry.writeUInt32BE(16, 0);
  entry.write(format, 4, 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(1, 4);
  return box('stsd', head, entry);
}

export function stco(offsets: number[]): Buffer {
  const b = Buffer.alloc(8 + offsets.length * 4);
  b.writeUInt32BE(offsets.length, 4);
  offsets.forEach((o, i) => b.writeUInt32BE(o, 8 + i * 4));
  return box('stco', b);
}

export function co64(offsets: number[]): Buffer {
  const b = Buffer.alloc(8 + offsets.length * 8);
  b.writeUInt32BE(offsets.length, 4);
  offsets.forEach((o, i) => b.writeBigUInt64BE(BigInt(o), 8 + i * 8));
  return box('co64', b);
}

export interface TrakSpec {
  handler: 'vide' | 'soun' | 'text';
  codec: string;
  width?: number;
  height?: number;
  rotate90?: boolean;
  /** `stco` (default) or `co64` chunk offsets. */
  offsets?: number[];
  co64?: boolean;
}

export function trak(t: TrakSpec): Buffer {
  const offsets = t.offsets ?? [];
  const table = t.co64 ? co64(offsets) : stco(offsets);
  return box(
    'trak',
    tkhd(t.width ?? 0, t.height ?? 0, t.rotate90),
    box(
      'mdia',
      hdlr(t.handler),
      box('minf', box('stbl', stsd(t.codec), table)),
    ),
  );
}

export interface Mp4Spec {
  major?: string;
  compat?: string[];
  timescale?: number;
  duration?: number;
  mvhdVersion?: number;
  tracks?: TrakSpec[];
  /** Media payload size (bytes of the mdat body). */
  mdatBytes?: number;
  /** moov after mdat (not faststart). */
  moovLast?: boolean;
  /** Extra moov children (e.g. mvex). */
  moovExtra?: Buffer[];
}

/**
 * A complete file. Chunk offsets given as `-1` are replaced by the absolute
 * offset of the mdat body (so tests can verify relocation).
 */
export function buildMp4(spec: Mp4Spec = {}): {
  file: Buffer;
  mdatBodyOffset: number;
  moovSize: number;
} {
  const head = ftyp(spec.major ?? 'isom', spec.compat ?? ['isom', 'avc1']);
  const mdatBody = Buffer.alloc(spec.mdatBytes ?? 64);
  for (let i = 0; i < mdatBody.length; i++) mdatBody[i] = i % 251;
  const mdat = box('mdat', mdatBody);
  const tracks = spec.tracks ?? [
    {
      handler: 'vide',
      codec: 'avc1',
      width: 1920,
      height: 1080,
      offsets: [-1],
    },
    { handler: 'soun', codec: 'mp4a', offsets: [-1] },
  ];
  const build = (mdatBodyOffset: number) =>
    box(
      'moov',
      mvhd(
        spec.timescale ?? 1000,
        spec.duration ?? 10_000,
        spec.mvhdVersion ?? 0,
      ),
      ...tracks.map((t) =>
        trak({
          ...t,
          offsets: (t.offsets ?? []).map((o) =>
            o === -1 ? mdatBodyOffset : o,
          ),
        }),
      ),
      ...(spec.moovExtra ?? []),
    );
  const probeMoov = build(0);
  const mdatBodyOffset = spec.moovLast
    ? head.length + 8
    : head.length + probeMoov.length + 8;
  const moov = build(mdatBodyOffset);
  const file = spec.moovLast
    ? Buffer.concat([head, mdat, moov])
    : Buffer.concat([head, moov, mdat]);
  return { file, mdatBodyOffset, moovSize: moov.length };
}
