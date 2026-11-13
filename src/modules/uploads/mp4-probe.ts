/**
 * Server-side MP4 inspection without ffmpeg (plans/product-video/CONTRACT.md
 * §4.4). The file is read through a descriptor: only box headers and the
 * `moov` box (capped at 8 MiB) are loaded, never the media data.
 *
 * Checks, in order: `ftyp` first with an MP4 brand (QuickTime refused),
 * `moov` present, `mvhd` duration, duration cap, an H.264 (`avc1`/`avc3`)
 * video track, AAC (`mp4a`) audio when present, an average-bitrate cap, and
 * faststart. A file whose `moov` follows the media data is rewritten into a
 * second temp file with `moov` in front (qt-faststart algorithm: chunk
 * offsets of the moved data are shifted by the `moov` size).
 */
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';

export type Mp4ProbeErrorCode =
  | 'UPLOAD_VIDEO_TYPE'
  | 'UPLOAD_VIDEO_UNREADABLE'
  | 'UPLOAD_VIDEO_TOO_LONG'
  | 'UPLOAD_VIDEO_CODEC'
  | 'UPLOAD_VIDEO_BITRATE_TOO_HIGH'
  | 'UPLOAD_VIDEO_NOT_FASTSTART';

export class Mp4ProbeError extends Error {
  constructor(
    readonly code: Mp4ProbeErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'Mp4ProbeError';
  }
}

export interface Mp4ProbeOptions {
  /** Duration cap in seconds (0.5 s tolerance is added). */
  maxSeconds: number;
  /** Average bitrate cap in kbit/s, applied above `bitrateMinBytes`. */
  maxKbps: number;
  /** Default 4 MiB. */
  bitrateMinBytes?: number;
  /** Where the faststart copy is written (default: `<path>.faststart`). */
  relocatedPath?: string;
}

export interface Mp4ProbeResult {
  /** Exact duration in seconds. */
  seconds: number;
  /** `Math.max(1, Math.round(seconds))`. */
  durationS: number;
  /** Display size (rotation from the track matrix applied); null when 0. */
  width: number | null;
  height: number | null;
  sizeBytes: number;
  videoCodec: string;
  audioCodec: string | null;
  /** True when `relocatedPath` holds the rewritten (faststart) file. */
  faststartFixed: boolean;
  /** The file to store: the input, or the faststart copy. */
  outputPath: string;
}

export const MP4_MAX_MOOV_BYTES = 8 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 100_000;
const COPY_CHUNK = 1024 * 1024;

/** Major/compatible brands accepted as ISO-BMFF MP4. */
export const MP4_BRANDS: ReadonlySet<string> = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'dash',
]);

const VIDEO_CODECS = new Set(['avc1', 'avc3']);
const AUDIO_CODECS = new Set(['mp4a']);

/** A box inside a buffer: `start` = header start, `body` = payload start. */
interface BufBox {
  type: string;
  start: number;
  body: number;
  end: number;
}

/** A top-level box of the file. */
interface FileBox {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
  /** The 32-bit size field was 0 ("to end of file"). */
  toEof: boolean;
}

const unreadable = (message: string) =>
  new Mp4ProbeError('UPLOAD_VIDEO_UNREADABLE', message);

async function readAt(
  fh: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(
      buf,
      done,
      length - done,
      position + done,
    );
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

function u64ToNumber(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64BE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw unreadable('64-bit value out of range');
  }
  return Number(v);
}

/** Walks the top-level boxes from the file headers only. */
async function topLevelBoxes(
  fh: FileHandle,
  fileSize: number,
): Promise<FileBox[]> {
  const boxes: FileBox[] = [];
  let offset = 0;
  while (offset < fileSize) {
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) throw unreadable('Too many boxes');
    if (fileSize - offset < 8) {
      // Trailing padding shorter than a box header is tolerated.
      break;
    }
    const head = await readAt(fh, offset, 16);
    if (head.length < 8) throw unreadable('Truncated box header');
    const size32 = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let size: number;
    let headerSize = 8;
    let toEof = false;
    if (size32 === 1) {
      if (head.length < 16) throw unreadable('Truncated largesize header');
      size = u64ToNumber(head, 8);
      headerSize = 16;
    } else if (size32 === 0) {
      size = fileSize - offset;
      toEof = true;
    } else {
      size = size32;
    }
    if (size < headerSize || offset + size > fileSize) {
      throw unreadable(`Box "${type}" exceeds the file`);
    }
    boxes.push({ type, offset, size, headerSize, toEof });
    offset += size;
  }
  return boxes;
}

/** Child boxes of `buf[from, to)`. */
function childBoxes(buf: Buffer, from: number, to: number): BufBox[] {
  const out: BufBox[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size32 = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let size: number;
    let header = 8;
    if (size32 === 1) {
      if (at + 16 > to) throw unreadable('Truncated child largesize');
      size = u64ToNumber(buf, at + 8);
      header = 16;
    } else if (size32 === 0) {
      size = to - at;
    } else {
      size = size32;
    }
    if (size < header || at + size > to) {
      throw unreadable(`Child box "${type}" exceeds its parent`);
    }
    out.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

const firstChild = (buf: Buffer, parent: BufBox, type: string) =>
  childBoxes(buf, parent.body, parent.end).find((b) => b.type === type);

function need(box: BufBox, bytes: number): void {
  if (box.end - box.body < bytes) {
    throw unreadable(`Box "${box.type}" is too short`);
  }
}

/** `mvhd` → [timescale, duration]. */
function readMvhd(buf: Buffer, box: BufBox): [number, number] {
  need(box, 4);
  const version = buf[box.body];
  if (version === 1) {
    need(box, 32);
    return [buf.readUInt32BE(box.body + 20), u64ToNumber(buf, box.body + 24)];
  }
  need(box, 20);
  const duration = buf.readUInt32BE(box.body + 16);
  // 0xFFFFFFFF means "unknown" in a v0 box.
  return [
    buf.readUInt32BE(box.body + 12),
    duration === 0xffffffff ? 0 : duration,
  ];
}

/** `mvex/mehd` fragment duration (fragmented MP4), or 0. */
function readMehd(buf: Buffer, moov: BufBox): number {
  const mvex = firstChild(buf, moov, 'mvex');
  if (!mvex) return 0;
  const mehd = firstChild(buf, mvex, 'mehd');
  if (!mehd) return 0;
  need(mehd, 8);
  if (buf[mehd.body] === 1) {
    need(mehd, 12);
    return u64ToNumber(buf, mehd.body + 4);
  }
  return buf.readUInt32BE(mehd.body + 4);
}

/** `tkhd` → display size (16.16 fixed, last 8 bytes; 90/270° rotation swaps). */
function readTkhdSize(
  buf: Buffer,
  box: BufBox,
): { width: number; height: number } {
  need(box, 84);
  const version = buf[box.body];
  const matrixAt = box.body + (version === 1 ? 52 : 40);
  if (version === 1) need(box, 96);
  let width = Math.round(buf.readUInt32BE(box.end - 8) / 65536);
  let height = Math.round(buf.readUInt32BE(box.end - 4) / 65536);
  const a = buf.readInt32BE(matrixAt);
  const b = buf.readInt32BE(matrixAt + 4);
  const c = buf.readInt32BE(matrixAt + 12);
  const d = buf.readInt32BE(matrixAt + 16);
  if (a === 0 && d === 0 && Math.abs(b) === 65536 && Math.abs(c) === 65536) {
    [width, height] = [height, width];
  }
  return { width, height };
}

interface TrackInfo {
  handler: string;
  codec: string | null;
  width: number;
  height: number;
}

function readTrack(buf: Buffer, trak: BufBox): TrackInfo {
  const tkhd = firstChild(buf, trak, 'tkhd');
  const mdia = firstChild(buf, trak, 'mdia');
  if (!mdia) return { handler: '', codec: null, width: 0, height: 0 };
  const hdlr = firstChild(buf, mdia, 'hdlr');
  let handler = '';
  if (hdlr) {
    need(hdlr, 12);
    handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
  }
  let codec: string | null = null;
  const minf = firstChild(buf, mdia, 'minf');
  const stbl = minf ? firstChild(buf, minf, 'stbl') : undefined;
  const stsd = stbl ? firstChild(buf, stbl, 'stsd') : undefined;
  if (stsd) {
    need(stsd, 16);
    const entries = buf.readUInt32BE(stsd.body + 4);
    if (entries > 0)
      codec = buf.toString('latin1', stsd.body + 12, stsd.body + 16);
  }
  const size =
    tkhd && handler === 'vide'
      ? readTkhdSize(buf, tkhd)
      : { width: 0, height: 0 };
  return { handler, codec, ...size };
}

/** True when a direct child of `box` is `type`. */
function containsBox(buf: Buffer, box: BufBox, type: string): boolean {
  for (const child of childBoxes(buf, box.body, box.end)) {
    if (child.type === type) return true;
  }
  return false;
}

const OFFSET_CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl']);

/**
 * Rewrites every `stco` / `co64` chunk offset inside `moov` (in place) with
 * `map(offset)`. Throws NOT_FASTSTART when a 32-bit offset would overflow.
 */
export function patchChunkOffsets(
  moov: Buffer,
  map: (offset: number) => number,
): number {
  let patched = 0;
  const walk = (from: number, to: number) => {
    for (const box of childBoxes(moov, from, to)) {
      if (OFFSET_CONTAINERS.has(box.type)) {
        walk(box.body, box.end);
      } else if (box.type === 'stco' || box.type === 'co64') {
        need(box, 8);
        const count = moov.readUInt32BE(box.body + 4);
        const width = box.type === 'stco' ? 4 : 8;
        if (box.body + 8 + count * width > box.end) {
          throw unreadable(`"${box.type}" entry count exceeds the box`);
        }
        for (let i = 0; i < count; i++) {
          const at = box.body + 8 + i * width;
          if (width === 4) {
            const next = map(moov.readUInt32BE(at));
            if (next > 0xffffffff) {
              throw new Mp4ProbeError(
                'UPLOAD_VIDEO_NOT_FASTSTART',
                'Chunk offsets overflow after moving moov; export the video with "fast start"',
              );
            }
            moov.writeUInt32BE(next, at);
          } else {
            moov.writeBigUInt64BE(BigInt(map(u64ToNumber(moov, at))), at);
          }
          patched++;
        }
      }
    }
  };
  // Skip the moov header itself.
  const size32 = moov.readUInt32BE(0);
  walk(size32 === 1 ? 16 : 8, moov.length);
  return patched;
}

async function copyRange(
  src: FileHandle,
  dst: FileHandle,
  from: number,
  length: number,
): Promise<void> {
  const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(length, 1)));
  let done = 0;
  while (done < length) {
    const want = Math.min(buf.length, length - done);
    const { bytesRead } = await src.read(buf, 0, want, from + done);
    if (bytesRead === 0) throw unreadable('Unexpected end of file');
    await dst.write(buf, 0, bytesRead);
    done += bytesRead;
  }
}

/**
 * Writes the faststart copy: the boxes before the first `mdat`, then `moov`
 * (offsets patched), then the remaining boxes in their order without the
 * old `moov`. Data that sat between the insertion point and the old `moov`
 * moves forward by `moov.size`; data after the old `moov` keeps its offset.
 */
async function relocateMoov(
  src: FileHandle,
  boxes: FileBox[],
  moovBox: FileBox,
  moov: Buffer,
  insertAt: number,
  outPath: string,
): Promise<void> {
  const moovStart = moovBox.offset;
  const moovSize = moov.length;
  if (moovBox.toEof) {
    // A "to end of file" moov needs an explicit size once it moves.
    moov.writeUInt32BE(moovSize, 0);
  }
  patchChunkOffsets(moov, (o) =>
    o >= insertAt && o < moovStart ? o + moovSize : o,
  );
  const dst = await fs.open(outPath, 'w');
  try {
    for (const b of boxes) {
      if (b.offset >= insertAt) break;
      await copyRange(src, dst, b.offset, b.size);
    }
    await dst.write(moov, 0, moov.length);
    for (const b of boxes) {
      if (b.offset < insertAt || b === moovBox) continue;
      await copyRange(src, dst, b.offset, b.size);
    }
    await dst.sync();
  } finally {
    await dst.close();
  }
}

/**
 * Probes the MP4 at `filePath`. Throws `Mp4ProbeError` with the contract's
 * coded reasons; on success the caller stores `result.outputPath` and
 * removes both temp files afterwards.
 */
export async function probeMp4(
  filePath: string,
  opts: Mp4ProbeOptions,
): Promise<Mp4ProbeResult> {
  const fh = await fs.open(filePath, 'r');
  try {
    const sizeBytes = (await fh.stat()).size;
    if (sizeBytes < 8) {
      throw new Mp4ProbeError('UPLOAD_VIDEO_TYPE', 'Not an MP4 file', {
        reason: 'not_mp4',
      });
    }
    const first = await readAt(fh, 0, 8);
    if (first.toString('latin1', 4, 8) !== 'ftyp') {
      throw new Mp4ProbeError('UPLOAD_VIDEO_TYPE', 'Not an MP4 file', {
        reason: 'not_mp4',
      });
    }
    const boxes = await topLevelBoxes(fh, sizeBytes);
    const ftyp = boxes[0];
    if (ftyp.size < 16 || ftyp.size > 4096) {
      throw unreadable('Invalid ftyp box');
    }
    const ftypBuf = await readAt(fh, ftyp.offset, ftyp.size);
    const major = ftypBuf.toString(
      'latin1',
      ftyp.headerSize,
      ftyp.headerSize + 4,
    );
    if (major === 'qt  ') {
      throw new Mp4ProbeError(
        'UPLOAD_VIDEO_TYPE',
        'QuickTime files are not supported',
        { reason: 'quicktime' },
      );
    }
    const brands = [major];
    for (let at = ftyp.headerSize + 8; at + 4 <= ftyp.size; at += 4) {
      brands.push(ftypBuf.toString('latin1', at, at + 4));
    }
    if (!brands.some((b) => MP4_BRANDS.has(b))) {
      throw new Mp4ProbeError('UPLOAD_VIDEO_TYPE', 'Not an MP4 file', {
        reason: 'not_mp4',
      });
    }

    const moovBox = boxes.find((b) => b.type === 'moov');
    if (!moovBox) throw unreadable('No moov box');
    if (moovBox.size > MP4_MAX_MOOV_BYTES)
      throw unreadable('moov box too large');
    const moov = await readAt(fh, moovBox.offset, moovBox.size);
    if (moov.length !== moovBox.size) throw unreadable('Truncated moov box');
    const moovSelf: BufBox = {
      type: 'moov',
      start: 0,
      body: moovBox.headerSize,
      end: moov.length,
    };

    const firstMdat = boxes.find((b) => b.type === 'mdat');
    const needsFaststart = !!firstMdat && firstMdat.offset < moovBox.offset;
    if (containsBox(moov, moovSelf, 'cmov')) {
      if (needsFaststart) {
        throw new Mp4ProbeError(
          'UPLOAD_VIDEO_NOT_FASTSTART',
          'Compressed movie header cannot be moved; export the video with "fast start"',
        );
      }
      throw unreadable('Compressed movie header');
    }

    const mvhd = firstChild(moov, moovSelf, 'mvhd');
    if (!mvhd) throw unreadable('No mvhd box');
    const [timescale, mvhdDuration] = readMvhd(moov, mvhd);
    if (!timescale) throw unreadable('mvhd timescale is 0');
    const units = mvhdDuration || readMehd(moov, moovSelf);
    if (!units) throw unreadable('Unknown duration');
    const seconds = units / timescale;
    if (seconds > opts.maxSeconds + 0.5) {
      throw new Mp4ProbeError(
        'UPLOAD_VIDEO_TOO_LONG',
        `Video is too long (max ${opts.maxSeconds} s)`,
        { maxSeconds: opts.maxSeconds, durationS: Math.round(seconds) },
      );
    }

    const tracks = childBoxes(moov, moovSelf.body, moovSelf.end)
      .filter((b) => b.type === 'trak')
      .map((t) => readTrack(moov, t));
    const video = tracks.filter((t) => t.handler === 'vide');
    if (video.length === 0) throw unreadable('No video track');
    for (const t of video) {
      if (!t.codec || !VIDEO_CODECS.has(t.codec)) {
        throw new Mp4ProbeError(
          'UPLOAD_VIDEO_CODEC',
          `Video codec "${t.codec ?? 'unknown'}" is not supported; use H.264`,
          { codec: (t.codec ?? 'unknown').trim() },
        );
      }
    }
    const audio = tracks.filter((t) => t.handler === 'soun');
    for (const t of audio) {
      if (!t.codec || !AUDIO_CODECS.has(t.codec)) {
        throw new Mp4ProbeError(
          'UPLOAD_VIDEO_CODEC',
          `Audio codec "${t.codec ?? 'unknown'}" is not supported; use AAC`,
          { codec: (t.codec ?? 'unknown').trim() },
        );
      }
    }

    const minBytes = opts.bitrateMinBytes ?? 4 * 1024 * 1024;
    if (sizeBytes > minBytes && seconds > 0) {
      const kbps = Math.round((sizeBytes * 8) / seconds / 1000);
      if (kbps > opts.maxKbps) {
        throw new Mp4ProbeError(
          'UPLOAD_VIDEO_BITRATE_TOO_HIGH',
          `Video bitrate is too high (max ${opts.maxKbps} kbit/s)`,
          { maxKbps: opts.maxKbps, kbps },
        );
      }
    }

    let outputPath = filePath;
    if (needsFaststart && firstMdat) {
      outputPath = opts.relocatedPath ?? `${filePath}.faststart`;
      try {
        await relocateMoov(
          fh,
          boxes,
          moovBox,
          moov,
          firstMdat.offset,
          outputPath,
        );
      } catch (e) {
        await fs.unlink(outputPath).catch(() => undefined);
        if (e instanceof Mp4ProbeError) throw e;
        throw new Mp4ProbeError(
          'UPLOAD_VIDEO_NOT_FASTSTART',
          `Could not move the movie header: ${(e as Error).message}`,
        );
      }
    }

    const v = video[0];
    return {
      seconds,
      durationS: Math.max(1, Math.round(seconds)),
      width: v.width > 0 ? v.width : null,
      height: v.height > 0 ? v.height : null,
      sizeBytes,
      videoCodec: v.codec as string,
      audioCodec: audio[0]?.codec ?? null,
      faststartFixed: outputPath !== filePath,
      outputPath,
    };
  } finally {
    await fh.close();
  }
}
