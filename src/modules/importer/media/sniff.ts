/** Magic-byte sniffing of fetched media (M4.4 §7): jpeg, png, gif, webp only. */

export type SniffedImage = 'jpeg' | 'png' | 'gif' | 'webp';

export const SNIFFED_MIME: Record<SniffedImage, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export const SNIFFED_EXT: Record<SniffedImage, 'jpg' | 'png' | 'gif' | 'webp'> =
  {
    jpeg: 'jpg',
    png: 'png',
    gif: 'gif',
    webp: 'webp',
  };

/** The image type of the first bytes, or null (SVG, HTML and everything else). */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'jpeg';
  if (
    buf.length >= 8 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}
