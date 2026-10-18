import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import type { RequestUser } from '../../common/decorators';
import {
  FEED_CACHE_TTL_MS,
  FeedsService,
  type BuiltFeed,
} from './feeds.service';

/** Bytes written per res.write() call when streaming a feed body. */
const STREAM_CHUNK = 64 * 1024;

/**
 * Public feed routes (M5.6). No auth: the 32-char token in the path is the
 * credential; the app must be on for the store. Per-IP throttled (ad
 * platforms fetch a few times a day), bodies cached 10 min in the service
 * and advertised as such to the fetcher (Cache-Control + ETag / 304).
 */
@Controller('feeds')
export class FeedsPublicController {
  constructor(private readonly feeds: FeedsService) {}

  @Get(':storeSlug/:token/google.xml')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async google(
    @Param('storeSlug') storeSlug: string,
    @Param('token') token: string,
    @Query('market') market: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const feed = await this.feeds.publicFeed(
      storeSlug,
      token,
      'google',
      market,
    );
    send(res, feed, ifNoneMatch);
  }

  @Get(':storeSlug/:token/facebook.csv')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async facebook(
    @Param('storeSlug') storeSlug: string,
    @Param('token') token: string,
    @Query('market') market: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const feed = await this.feeds.publicFeed(
      storeSlug,
      token,
      'facebook',
      market,
    );
    send(res, feed, ifNoneMatch);
  }
}

/** Writes the feed in chunks; 304 when the fetcher already has this body. */
function send(res: Response, feed: BuiltFeed, ifNoneMatch?: string): void {
  res.setHeader('Cache-Control', `public, max-age=${FEED_CACHE_TTL_MS / 1000}`);
  res.setHeader('ETag', feed.etag);
  res.setHeader('X-Feed-Cache', feed.cached ? 'HIT' : 'MISS');
  res.setHeader('X-Feed-Items', String(feed.items));
  if (
    ifNoneMatch &&
    ifNoneMatch.split(',').some((t) => t.trim() === feed.etag)
  ) {
    res.status(304).end();
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', feed.contentType);
  res.setHeader('Content-Length', String(Buffer.byteLength(feed.body)));
  for (let i = 0; i < feed.body.length; i += STREAM_CHUNK) {
    res.write(feed.body.slice(i, i + STREAM_CHUNK));
  }
  res.end();
}

/** Creator routes of the feeds app: settings view, token rotation, validation. */
@Controller('feeds/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('feeds')
export class FeedsController {
  constructor(private readonly feeds: FeedsService) {}

  /** Settings (token generated on first read) + the public URLs per market. */
  @Get('settings')
  settings(@CurrentUser() user: RequestUser) {
    return this.feeds.mySettings(user.id);
  }

  /** New token; the old URLs stop working at once. */
  @Post('token/rotate')
  rotate(@CurrentUser() user: RequestUser) {
    return this.feeds.rotateToken(user.id);
  }

  /** Builds the feed server-side and reports counts + missing gtin/brand. */
  @Get('validate')
  validate(@CurrentUser() user: RequestUser, @Query('market') market?: string) {
    return this.feeds.validate(user.id, market);
  }
}
