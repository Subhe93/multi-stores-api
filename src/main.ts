import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { CorsOriginService } from './common/cors/cors-origin.service';
import { securityHeadersMiddleware } from './common/security/security-headers.middleware';
import { jwtSecretsProblem } from './common/security/jwt-secrets';
import {
  matchesAllowedOrigin,
  parseAllowedOrigins,
} from './common/cors/cors-origin.matcher';
import { PublicStorage } from './modules/storage/public-storage';
import { storageDriver } from './modules/storage/storage.config';
import { createUploadsServingHandler } from './modules/storage/uploads-serving';

/** `TRUST_PROXY`: a hop count, or a name/list Express understands ("loopback"). */
function parseTrustProxy(raw: string | undefined): number | string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

async function bootstrap() {
  // rawBody keeps the unparsed request body available (req.rawBody) on every
  // route, so the Stripe webhooks (platform /payments/webhook and Connect
  // /payments/webhook/connect) can verify signatures against the exact bytes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Access and refresh tokens must be signed with different secrets, or a
  // purpose token (2FA challenge, password reset) signed with JWT_SECRET
  // could pass as a refresh token. Refuse to start rather than run unsafe.
  // Both must be set: without JWT_REFRESH_SECRET, @nestjs/jwt silently falls
  // back to JWT_SECRET and a 7-day refresh token would pass as access token.
  // A rotation keeps the previous value in *_PREVIOUS for a grace window;
  // it must not equal the other kind's secret either (jwt-secrets.ts).
  const jwtProblem = jwtSecretsProblem(process.env);
  if (jwtProblem) {
    throw new Error(jwtProblem);
  }

  // Reverse proxy (deploy): TRUST_PROXY makes req.ip the real client, which
  // the per-IP throttles and the customer upload byte budget key on. A hop
  // count ("1" behind one nginx) or "loopback"; unset keeps Express's
  // default (no proxy trusted, req.ip = the proxy's address).
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  // Baseline security headers (docs/OPERATIONS.md "Security headers"). The
  // Express fingerprint header goes; nosniff / Referrer-Policy / HSTS (HTTPS
  // only, via req.secure + trust proxy) / X-Frame-Options go on every
  // response. Registered before the static handler so /uploads/* is covered.
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(securityHeadersMiddleware);

  // Serve uploaded files. Filenames are UUIDs, so the content at any given
  // URL never changes — mark them long-lived + immutable so browsers and the
  // CDN can cache aggressively (Lighthouse flagged the previous 4h TTL as
  // wasted bandwidth on repeat visits).
  //
  // STORAGE_DRIVER=s3: the objects live in the media bucket and the API
  // streams them (`/uploads/*` stays on this host, outside the /api prefix)
  // with the same headers as the static handler below.
  if (storageDriver() === 's3') {
    app.use('/uploads', createUploadsServingHandler(app.get(PublicStorage)));
  } else {
    app.useStaticAssets(join(process.cwd(), 'uploads'), {
      prefix: '/uploads/',
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year in ms
      immutable: true,
      setHeaders: (res: Response, filePath: string) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // An SVG is a document: navigating straight to an uploaded one would
        // run any script inside it on this origin. Forcing a download kills
        // that path while `<img src="...svg">` still renders normally
        // (embedded SVGs can't execute scripts).
        if (filePath.toLowerCase().endsWith('.svg')) {
          res.setHeader('Content-Disposition', 'attachment');
        }
        // Customer upload previews (M4.0) are purged by retention: a one-day
        // cache (not immutable) lets a purge take effect, and they are never
        // indexed. send() keeps a Cache-Control set here.
        if (/[\\/]customer-previews[\\/]/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.setHeader('X-Robots-Tag', 'noindex');
        }
      },
    });
  }

  app.setGlobalPrefix('api');

  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // CORS. CORS_ALLOWED_ORIGINS (comma separated) accepts exact origins and
  // one-level wildcards ("https://*.iwings-digital.com"). Origins outside the
  // list are then checked against the stores' custom domains (cached 5 min,
  // hits and misses alike), so a creator-owned storefront domain works without
  // a redeploy. Without the list we keep reflecting the request origin, which
  // is safe here only because authentication is Bearer-token, not cookie based.
  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const corsOrigins = app.get(CorsOriginService);

  if (allowedOrigins.length === 0) {
    console.warn(
      '[CORS] CORS_ALLOWED_ORIGINS is not set — every origin is being reflected.',
    );
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Requests with no origin (mobile apps, curl, server-side fetches).
      if (!origin) return callback(null, true);
      if (origin.startsWith('http://localhost:')) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (matchesAllowedOrigin(origin, allowedOrigins)) {
        return callback(null, true);
      }
      corsOrigins.isStoreOrigin(origin).then(
        (allowed) => callback(null, allowed),
        (err: unknown) =>
          callback(err instanceof Error ? err : new Error(String(err))),
      );
    },
    credentials: true,
    // Let browser clients read the attachment filename of file downloads
    // (backup dumps, tax CSV reports) on cross-origin responses, and the
    // truncation flag of capped CSV exports.
    exposedHeaders: ['Content-Disposition', 'X-Truncated'],
  });

  // SIGTERM/SIGINT run onModuleDestroy hooks (the designer print worker
  // hands its RENDERING rows back, browsers close) before the process exits.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}/api`);
}
void bootstrap();
