import { Logger } from '@nestjs/common';
import {
  CspReportService,
  flushIntervalMs,
  MAX_BUCKETS,
} from './csp-report.service';
import type { CspViolationSummary } from './csp-report.parser';

const report = (
  over: Partial<CspViolationSummary> = {},
): CspViolationSummary => ({
  directive: 'script-src-elem',
  blocked: 'evil.example',
  document: 'namez.se',
  disposition: 'report',
  blockedSample: 'https://evil.example/x.js',
  sourceSample: null,
  ...over,
});

describe('CspReportService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('deduplicates by directive + blocked host + document host', () => {
    const svc = new CspReportService();
    svc.record([report(), report(), report({ document: 'app.shopsdoor.com' })]);
    expect(svc.pendingKeys()).toBe(2);
    svc.flush();
    expect(warn).toHaveBeenCalledTimes(2);
    const lines = (warn.mock.calls as [string][]).map(
      (c) => JSON.parse(c[0]) as Record<string, unknown>,
    );
    const first = lines[0];
    expect(first).toMatchObject({ document: 'namez.se', count: 2 });
    expect(svc.pendingKeys()).toBe(0);
  });

  it('flush is silent when nothing was recorded', () => {
    const svc = new CspReportService();
    svc.flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('caps distinct keys and reports the overflow count', () => {
    const svc = new CspReportService();
    const many = Array.from({ length: MAX_BUCKETS + 7 }, (_, i) =>
      report({ blocked: `h${i}.example` }),
    );
    svc.record(many);
    expect(svc.pendingKeys()).toBe(MAX_BUCKETS);
    svc.flush();
    const calls = warn.mock.calls as [string][];
    const last = JSON.parse(calls[calls.length - 1][0]) as {
      overflow: number;
    };
    expect(last.overflow).toBe(7);
  });

  it('flushes on module destroy and clears the timer', () => {
    jest.useFakeTimers();
    try {
      const svc = new CspReportService();
      svc.onModuleInit();
      svc.record([report()]);
      jest.advanceTimersByTime(flushIntervalMs(undefined));
      expect(warn).toHaveBeenCalledTimes(1);
      svc.record([report()]);
      svc.onModuleDestroy();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads the flush interval from env with sane bounds', () => {
    expect(flushIntervalMs(undefined)).toBe(600_000);
    expect(flushIntervalMs('1')).toBe(60_000);
    expect(flushIntervalMs('0')).toBe(600_000);
    expect(flushIntervalMs('abc')).toBe(600_000);
  });
});
