import { UserRole } from '@prisma/client';
import sharp from 'sharp';
import { SafeFetchError } from '../importer/media/safe-fetch';
import type { UploadsService } from './uploads.service';
import { type HostFetcher, VideoLinkService } from './video-link.service';

const user = {
  id: 'u1',
  role: UserRole.CREATOR,
  email: 'x',
  status: 'ACTIVE',
  storeId: null,
} as never;

describe('VideoLinkService', () => {
  let jpeg: Buffer;
  beforeAll(async () => {
    jpeg = await sharp({
      create: { width: 8, height: 6, channels: 3, background: '#123' },
    })
      .jpeg()
      .toBuffer();
  });

  const uploads = () =>
    ({
      storeBuffer: jest.fn().mockResolvedValue({
        url: '/uploads/video-posters/p.webp',
        file_type: 'webp',
        file_size: 10,
      }),
    }) as unknown as UploadsService & { storeBuffer: jest.Mock };

  const ok = (body: Buffer | string, status = 200) => ({
    status,
    headers: {},
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    url: 'x',
  });

  it('YouTube: canonical URL + poster from i.ytimg.com stored for the uploader', async () => {
    const up = uploads();
    const fetcher: HostFetcher = jest.fn().mockResolvedValue(ok(jpeg));
    const res = await new VideoLinkService(up, fetcher).resolve(
      'https://youtu.be/dQw4w9WgXcQ',
      user,
    );
    expect(res).toEqual({
      kind: 'youtube',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      external_id: 'dQw4w9WgXcQ',
      poster_url: '/uploads/video-posters/p.webp',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'i.ytimg.com',
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      expect.objectContaining({ maxBytes: 2 * 1024 * 1024 }),
    );
    expect(up.storeBuffer).toHaveBeenCalledWith(
      jpeg,
      '.jpg',
      // The poster folder the orphan sweep covers (unsaved lookups).
      'video-posters',
      expect.objectContaining({ uploader: user }),
    );
  });

  it('returns poster_url null when the fetch fails (still a success)', async () => {
    const up = uploads();
    const fetcher: HostFetcher = jest
      .fn()
      .mockRejectedValue(
        new SafeFetchError('IMPORT_MEDIA_FETCH_FAILED', 'timeout'),
      );
    const res = await new VideoLinkService(up, fetcher).resolve(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      user,
    );
    expect(res.poster_url).toBeNull();
    expect(res.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(up.storeBuffer).not.toHaveBeenCalled();
  });

  it('a non-image body, a 404 or a failing image decode give poster_url null', async () => {
    const up = uploads();
    for (const r of [ok('<html>'), ok(jpeg, 404)]) {
      const res = await new VideoLinkService(
        up,
        jest.fn().mockResolvedValue(r),
      ).resolve('https://youtu.be/dQw4w9WgXcQ', user);
      expect(res.poster_url).toBeNull();
    }
    up.storeBuffer.mockRejectedValueOnce(new Error('corrupt'));
    const res = await new VideoLinkService(
      up,
      jest.fn().mockResolvedValue(ok(jpeg)),
    ).resolve('https://youtu.be/dQw4w9WgXcQ', user);
    expect(res.poster_url).toBeNull();
  });

  it('Vimeo: the oEmbed thumbnail must be on i.vimeocdn.com', async () => {
    const up = uploads();
    const fetcher = jest.fn((host: string, _url: string) =>
      Promise.resolve(
        host === 'vimeo.com'
          ? ok(
              JSON.stringify({
                thumbnail_url: 'https://i.vimeocdn.com/video/1_640.jpg',
              }),
            )
          : ok(jpeg),
      ),
    );
    const res = await new VideoLinkService(up, fetcher).resolve(
      'https://vimeo.com/76979871/abcdef1234',
      user,
    );
    expect(res).toMatchObject({
      kind: 'vimeo',
      url: 'https://vimeo.com/76979871/abcdef1234',
      external_id: '76979871',
      poster_url: '/uploads/video-posters/p.webp',
    });
    expect(fetcher.mock.calls[0][1]).toBe(
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent('https://vimeo.com/76979871/abcdef1234')}`,
    );
    expect(fetcher.mock.calls[1][0]).toBe('i.vimeocdn.com');

    const evil = jest
      .fn()
      .mockResolvedValue(
        ok(JSON.stringify({ thumbnail_url: 'https://evil.example/x.jpg' })),
      );
    const res2 = await new VideoLinkService(up, evil).resolve(
      'https://vimeo.com/1',
      user,
    );
    expect(res2.poster_url).toBeNull();
    expect(evil).toHaveBeenCalledTimes(1);
  });

  it('refuses other hosts with 400 VIDEO_URL_NOT_ALLOWED', async () => {
    const svc = new VideoLinkService(uploads(), jest.fn());
    for (const url of [
      'https://evil.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
    ]) {
      await expect(svc.resolve(url, user)).rejects.toMatchObject({
        response: { code: 'VIDEO_URL_NOT_ALLOWED' },
        status: 400,
      });
    }
  });
});
