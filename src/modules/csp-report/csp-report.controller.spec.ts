import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { CspReportModule } from './csp-report.module';
import { CspReportService } from './csp-report.service';

describe('POST /api/csp-report', () => {
  let app: INestApplication;
  let service: CspReportService;
  let record: jest.SpyInstance<void, Parameters<CspReportService['record']>>;
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
        CspReportModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    service = app.get(CspReportService);
    record = jest.spyOn(service, 'record');
  });

  afterEach(async () => {
    await app.close();
  });

  const legacy = JSON.stringify({
    'csp-report': {
      'document-uri': 'https://namez.se/?t=SECRET',
      'blocked-uri': 'https://evil.example/a.js',
      'effective-directive': 'script-src-elem',
    },
  });

  it('accepts application/csp-report', async () => {
    await request(http())
      .post('/api/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(legacy)
      .expect(204);
    expect(record).toHaveBeenCalledWith([
      expect.objectContaining({
        blocked: 'evil.example',
        document: 'namez.se',
      }),
    ]);
  });

  it('accepts application/reports+json', async () => {
    await request(http())
      .post('/api/csp-report')
      .set('Content-Type', 'application/reports+json')
      .send(
        JSON.stringify([
          {
            type: 'csp-violation',
            body: {
              documentURL: 'https://app.shopsdoor.com/x',
              blockedURL: 'eval',
              effectiveDirective: 'script-src',
            },
          },
        ]),
      )
      .expect(204);
    expect(record).toHaveBeenCalledWith([
      expect.objectContaining({
        blocked: 'eval',
        document: 'app.shopsdoor.com',
      }),
    ]);
  });

  it('accepts plain application/json too', async () => {
    await request(http())
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send(legacy)
      .expect(204);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toHaveLength(1);
  });

  it('refuses an oversized body with 413', async () => {
    await request(http())
      .post('/api/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({ pad: 'x'.repeat(20_000) }))
      .expect(413);
    expect(record).not.toHaveBeenCalled();
  });

  it('answers 400 on malformed JSON without echoing it', async () => {
    const res = await request(http())
      .post('/api/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send('{not json SECRET')
      .expect(400);
    expect(res.text).not.toContain('SECRET');
  });

  it('throttles at 60 requests per minute per IP', async () => {
    const server = http();
    for (let i = 0; i < 60; i++) {
      await request(server)
        .post('/api/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(legacy)
        .expect(204);
    }
    await request(server)
      .post('/api/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(legacy)
      .expect(429);
  });
});
