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

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-side)
      if (!origin) return callback(null, true);
      // Allow all localhost ports in development
      if (origin.startsWith('http://localhost:')) return callback(null, true);
      // Allow custom subdomains in production
      callback(null, true);
    },
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}/api`);
}
bootstrap();
