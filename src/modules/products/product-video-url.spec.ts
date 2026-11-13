import { parseExternalVideoUrl } from './product-video-url';

// Strict YouTube / Vimeo whitelist (contract 3.4): every accepted shape maps
// to the canonical watch URL; anything else is null.

const ID = 'dQw4w9WgXcQ';
const YT = `https://www.youtube.com/watch?v=${ID}`;

describe('parseExternalVideoUrl', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `http://m.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `  https://youtu.be/${ID}  `,
  ])('YouTube %s', (raw) => {
    expect(parseExternalVideoUrl(raw)).toEqual({
      kind: 'youtube',
      id: ID,
      canonicalUrl: YT,
    });
  });

  it.each([
    ['https://vimeo.com/76979871', undefined],
    ['https://www.vimeo.com/76979871', undefined],
    ['https://player.vimeo.com/video/76979871', undefined],
    ['https://vimeo.com/76979871/abc123def4', 'abc123def4'],
    ['https://player.vimeo.com/video/76979871?h=abc123def4', 'abc123def4'],
  ])('Vimeo %s', (raw, hash) => {
    expect(parseExternalVideoUrl(raw)).toEqual({
      kind: 'vimeo',
      id: '76979871',
      ...(hash ? { hash } : {}),
      canonicalUrl: hash
        ? `https://vimeo.com/76979871/${hash}`
        : 'https://vimeo.com/76979871',
    });
  });

  it.each([
    `https://evil.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://evil.com/youtube.com/watch?v=${ID}`,
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `ftp://youtube.com/watch?v=${ID}`,
    `https://user:pw@youtube.com/watch?v=${ID}`,
    `https://youtube.com:8443/watch?v=${ID}`,
    // 11 characters, but with characters outside [A-Za-z0-9_-].
    'https://www.youtube.com/watch?v=dQw4w9WgXc!',
    'https://www.youtube.com/watch?v=dQw4w9<gXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch',
    `https://www.youtube.com/channel/${ID}`,
    `https://youtu.be/${ID}/extra`,
    'https://vimeo.com/channels/staffpicks',
    'https://vimeo.com/76979871/bad!hash',
    'https://vimeo.com/1/2/3',
    'https://player.vimeo.com/76979871',
    'not a url',
    '',
  ])('rejects %s', (raw) => {
    expect(parseExternalVideoUrl(raw)).toBeNull();
  });

  it('null / undefined input is rejected without throwing', () => {
    expect(parseExternalVideoUrl(null as unknown as string)).toBeNull();
    expect(parseExternalVideoUrl(undefined as unknown as string)).toBeNull();
  });
});
