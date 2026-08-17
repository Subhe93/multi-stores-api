import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  // rawBody keeps the unparsed request body available (req.rawBody) on every
  // route, so the Stripe webhooks (platform /payments/webhook and Connect
  // /payments/webhook/connect) can verify signatures against the exact bytes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Serve uploaded files as static. Filenames are UUIDs, so the content at any
  // given URL never changes — mark them long-lived + immutable so browsers
  // and the CDN can cache aggressively (Lighthouse flagged the previous 4h
  // TTL as wasted bandwidth on repeat visits).
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year in ms
    immutable: true,
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // An SVG is a document: navigating straight to an uploaded one would run
      // any script inside it on this origin. Forcing a download kills that path
      // while `<img src="...svg">` still renders normally (embedded SVGs can't
      // execute scripts).
      if (filePath.toLowerCase().endsWith('.svg')) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  });

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

  // Stores can be served from creator-owned custom domains, so a hard-coded
  // allowlist isn't possible by default. Set CORS_ALLOWED_ORIGINS (comma
  // separated) to pin the origins once the deployment's domains are known;
  // without it we keep reflecting the request origin, which is safe here only
  // because authentication is Bearer-token rather than cookie based.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

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
      return callback(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}/api`);
}
bootstrap();
