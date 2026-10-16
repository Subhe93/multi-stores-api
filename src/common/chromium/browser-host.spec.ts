import { EventEmitter } from 'events';

// A fake playwright-core: every launch returns a fresh fake browser.
type FakeBrowser = EventEmitter & {
  connected: boolean;
  isConnected: () => boolean;
  close: jest.Mock;
};
const launched: FakeBrowser[] = [];
const launchMock = jest.fn((opts: Record<string, unknown>) => {
  void opts;
  const b = new EventEmitter() as FakeBrowser;
  b.connected = true;
  b.isConnected = () => b.connected;
  b.close = jest.fn(() => {
    b.connected = false;
    return Promise.resolve();
  });
  launched.push(b);
  return Promise.resolve(b);
});
jest.mock('playwright-core', () => ({ chromium: { launch: launchMock } }));

import {
  BrowserHost,
  Semaphore,
  SemaphoreBusyError,
  withTimeout,
} from './browser-host';

class Unavailable extends Error {}

const identity = {
  loggerName: 'TestHost',
  label: 'Test',
  unavailableNote: 'tests are unavailable',
  unavailable: (m: string, cause: unknown) =>
    Object.assign(new Unavailable(m), { cause }),
  isUnavailable: (e: unknown) => e instanceof Unavailable,
};

beforeEach(() => {
  launched.length = 0;
  launchMock.mockClear();
});

describe('BrowserHost (shared Chromium host, extracted from the invoice renderer)', () => {
  it('launches lazily, once, and reuses the browser', async () => {
    const host = new BrowserHost({ channel: 'chrome' }, identity);
    expect(launchMock).not.toHaveBeenCalled();
    await host.withBrowser(() => Promise.resolve(1));
    await host.withBrowser(() => Promise.resolve(2));
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0][0]).toMatchObject({
      headless: true,
      channel: 'chrome',
    });
    expect(host.launchCount).toBe(1);
    await host.close();
    expect(launched[0].close).toHaveBeenCalled();
  });

  it('passes extra args and prefers executablePath', async () => {
    const host = new BrowserHost(
      {
        executablePath: '/x/chrome',
        channel: 'msedge',
        args: ['--disable-gpu'],
      },
      identity,
    );
    await host.withBrowser(() => Promise.resolve());
    const opts = launchMock.mock.calls[0][0] as {
      executablePath?: string;
      channel?: string;
      args: string[];
    };
    expect(opts.executablePath).toBe('/x/chrome');
    expect(opts.channel).toBeUndefined();
    expect(opts.args).toContain('--disable-gpu');
    await host.close();
  });

  it('relaunches once when the browser died during a job', async () => {
    const host = new BrowserHost({ channel: 'chrome' }, identity);
    let calls = 0;
    const out = await host.withBrowser((b) => {
      calls++;
      if (calls === 1) {
        (b as unknown as FakeBrowser).connected = false;
        return Promise.reject(new Error('Target closed'));
      }
      return Promise.resolve('ok');
    });
    expect(out).toBe('ok');
    expect(host.launchCount).toBe(2);
    await host.close();
  });

  it('does not retry an error while the browser is still connected', async () => {
    const host = new BrowserHost({ channel: 'chrome' }, identity);
    await expect(
      host.withBrowser(() => Promise.reject(new Error('page error'))),
    ).rejects.toThrow('page error');
    expect(host.launchCount).toBe(1);
    await host.close();
  });

  it('a failed launch is the owner error and is not retried at once', async () => {
    launchMock.mockImplementationOnce(() =>
      Promise.reject(new Error('no browser')),
    );
    const host = new BrowserHost({ channel: 'chrome' }, identity);
    await expect(host.withBrowser(() => Promise.resolve())).rejects.toThrow(
      'Test engine could not start',
    );
    await expect(host.withBrowser(() => Promise.resolve())).rejects.toThrow(
      /recent failure/,
    );
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it('limits concurrency', async () => {
    const host = new BrowserHost(
      { channel: 'chrome', concurrency: 1 },
      identity,
    );
    let active = 0;
    let peak = 0;
    const job = () =>
      host.withBrowser(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([job(), job(), job()]);
    expect(peak).toBe(1);
    await host.close();
  });

  it('recycles the browser after N jobs (memory bound)', async () => {
    const host = new BrowserHost(
      { channel: 'chrome', recycleAfterJobs: 2 },
      identity,
    );
    await host.withBrowser(() => Promise.resolve());
    await host.withBrowser(() => Promise.resolve());
    await new Promise((r) => setImmediate(r));
    expect(launched[0].close).toHaveBeenCalled();
    await host.withBrowser(() => Promise.resolve());
    expect(host.launchCount).toBe(2);
    await host.close();
  });

  it('closes after the idle timeout', async () => {
    jest.useFakeTimers();
    try {
      const host = new BrowserHost(
        { channel: 'chrome', idleCloseMs: 1000 },
        identity,
      );
      await host.withBrowser(() => Promise.resolve());
      expect(host.isRunning).toBe(true);
      jest.advanceTimersByTime(1001);
      expect(launched[0].close).toHaveBeenCalled();
      expect(host.isRunning).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Semaphore / withTimeout', () => {
  it('Semaphore counts waiters as busy', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const second = s.acquire();
    expect(s.busy).toBe(2);
    s.release();
    await second;
    s.release();
    expect(s.busy).toBe(0);
  });

  it('withTimeout rejects a slow promise', async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 10, 'Slow job'),
    ).rejects.toThrow('Slow job timed out after 10 ms');
  });
});

describe('admission limits (designer lanes; off by default for invoices)', () => {
  it('Semaphore refuses past maxQueue and drops a timed-out waiter', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    await expect(s.acquire({ maxQueue: 0 })).rejects.toBeInstanceOf(
      SemaphoreBusyError,
    );
    const timedOut = s.acquire({ timeoutMs: 20 });
    await expect(timedOut).rejects.toMatchObject({ reason: 'timeout' });
    expect(s.waiting).toBe(0);
    s.release();
    expect(s.busy).toBe(0);
  });

  it('without limits the default lane queues without bound (invoice parity)', async () => {
    const host = new BrowserHost(
      { channel: 'chrome', concurrency: 1 },
      identity,
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = host.withBrowser(() => gate);
    const rest = Array.from({ length: 20 }, (_, i) =>
      host.withBrowser(() => Promise.resolve(i)),
    );
    expect(host.busy).toBe(21);
    release();
    await first;
    await expect(Promise.all(rest)).resolves.toHaveLength(20);
    await host.close();
  });

  it('a busy lane throws the owner unavailable error; other lanes still run', async () => {
    const host = new BrowserHost(
      {
        channel: 'chrome',
        lanes: {
          a: { concurrency: 1, maxQueue: 0 },
          b: { concurrency: 1, acquireTimeoutMs: 1000 },
        },
      },
      identity,
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = host.withBrowser(() => gate, 'a');
    await expect(
      host.withBrowser(() => Promise.resolve(1), 'a'),
    ).rejects.toBeInstanceOf(Unavailable);
    await expect(host.withBrowser(() => Promise.resolve(2), 'b')).resolves.toBe(
      2,
    );
    expect(host.laneBusy('a')).toBe(1);
    release();
    await first;
    expect(host.busy).toBe(0);
    await host.close();
  });
});
