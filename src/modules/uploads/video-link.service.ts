/**
 * `POST /uploads/video-link` (plans/product-video/CONTRACT.md §4.5): a
 * YouTube / Vimeo URL becomes its canonical watch URL plus a poster image
 * stored on our side (so the storefront never loads a third-party thumbnail
 * before the visitor clicks). The poster is fetched once through the
 * importer's SSRF-guarded fetcher (pinned DNS, private ranges refused,
 * size and time caps); any failure still answers 200 with `poster_url: null`.
 * Not gated by `PRODUCT_VIDEO_UPLOADS` (links use no disk beyond a poster).
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import type { RequestUser } from '../../common/decorators/current-user.decorator';
import {
  SafeFetcher,
  type SafeFetcherDeps,
  type SafeFetchResponse,
} from '../importer/media/safe-fetch';
import {
  parseExternalVideoUrl,
  type ExternalVideoKind,
  type ParsedExternalVideo,
} from '../products/product-video-url';
import { sniffUploadType } from './upload-sniff';
import { UploadsService } from './uploads.service';
import { VIDEO_POSTER_FOLDER } from './video-upload.config';

export class VideoLinkDto {
  @IsString()
  @MaxLength(2048)
  url!: string;
}

export interface VideoLinkResult {
  kind: ExternalVideoKind;
  url: string;
  external_id: string;
  poster_url: string | null;
}

/** Fetches one URL of one host (injectable for tests). */
export type HostFetcher = (
  host: string,
  url: string,
  opts: { maxBytes: number; accept: string },
) => Promise<SafeFetchResponse>;

/** Optional DI token to replace the poster fetcher (tests). */
export const VIDEO_LINK_FETCHER = 'VIDEO_LINK_FETCHER';

export const VIDEO_POSTER_TIMEOUT_MS = 5_000;
export const VIDEO_POSTER_MAX_BYTES = 2 * 1024 * 1024;
const OEMBED_MAX_BYTES = 64 * 1024;
/** Decoder cap for a thumbnail (they are at most a few megapixels). */
const POSTER_MAX_PIXELS = 40_000_000;
const VIMEO_THUMB_PREFIX = 'https://i.vimeocdn.com/';

/** The default fetcher: a SafeFetcher bound to exactly `host`, 5 s budget. */
export function safeHostFetcher(deps: SafeFetcherDeps = {}): HostFetcher {
  return (host, url, opts) =>
    new SafeFetcher(
      { siteHost: host, aliases: [] },
      {
        totalTimeoutMs: VIDEO_POSTER_TIMEOUT_MS,
        timeouts: {
          connectMs: VIDEO_POSTER_TIMEOUT_MS,
          headersMs: VIDEO_POSTER_TIMEOUT_MS,
          idleMs: VIDEO_POSTER_TIMEOUT_MS,
        },
        ...deps,
      },
    ).get(url, {
      maxBytes: opts.maxBytes,
      accept: opts.accept,
      purpose: 'rest',
    });
}

const IMAGE_EXTS = ['.jpg', '.png', '.webp'] as const;

@Injectable()
export class VideoLinkService {
  private readonly logger = new Logger(VideoLinkService.name);
  private readonly fetcher: HostFetcher;

  constructor(
    private readonly uploads: UploadsService,
    @Optional() @Inject(VIDEO_LINK_FETCHER) fetcher?: HostFetcher,
  ) {
    this.fetcher = fetcher ?? safeHostFetcher();
  }

  async resolve(rawUrl: string, user: RequestUser): Promise<VideoLinkResult> {
    const parsed = parseExternalVideoUrl(rawUrl);
    if (!parsed) {
      throw new BadRequestException({
        code: 'VIDEO_URL_NOT_ALLOWED',
        message: 'Only YouTube and Vimeo video links are supported',
      });
    }
    let poster: string | null = null;
    try {
      poster = await this.storePoster(parsed, user);
    } catch (e) {
      this.logger.warn(
        `Poster fetch failed for ${parsed.kind}:${parsed.id}: ${(e as Error).message}`,
      );
    }
    return {
      kind: parsed.kind,
      url: parsed.canonicalUrl,
      external_id: parsed.id,
      poster_url: poster,
    };
  }

  /** The thumbnail URL of the provider, or null. */
  private async thumbnailUrl(
    parsed: ParsedExternalVideo,
  ): Promise<string | null> {
    if (parsed.kind === 'youtube') {
      return `https://i.ytimg.com/vi/${parsed.id}/hqdefault.jpg`;
    }
    const oembed = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(parsed.canonicalUrl)}`;
    const res = await this.fetcher('vimeo.com', oembed, {
      maxBytes: OEMBED_MAX_BYTES,
      accept: 'application/json',
    });
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body.toString('utf8')) as {
      thumbnail_url?: unknown;
    };
    const thumb = json.thumbnail_url;
    return typeof thumb === 'string' && thumb.startsWith(VIMEO_THUMB_PREFIX)
      ? thumb
      : null;
  }

  private async storePoster(
    parsed: ParsedExternalVideo,
    user: RequestUser,
  ): Promise<string | null> {
    const thumb = await this.thumbnailUrl(parsed);
    if (!thumb) return null;
    const host = new URL(thumb).hostname.toLowerCase();
    const res = await this.fetcher(host, thumb, {
      maxBytes: VIDEO_POSTER_MAX_BYTES,
      accept: 'image/*',
    });
    if (res.status !== 200) return null;
    const ext = IMAGE_EXTS.find((e) => sniffUploadType(res.body, e));
    if (!ext) return null;
    // The poster folder: the orphan sweep reclaims posters of lookups
    // that were never saved (cancelled "Add link" dialogs, repeated checks).
    const stored = await this.uploads.storeBuffer(
      res.body,
      ext,
      VIDEO_POSTER_FOLDER,
      {
        uploader: user,
        limitInputPixels: POSTER_MAX_PIXELS,
      },
    );
    return stored.url;
  }
}
