/**
 * Shared headless-Chromium host through `playwright-core`, extracted from the
 * invoice PDF renderer (M3 D7) for the designer render pipeline (M4.2 §5.1).
 * Every user of it owns its own instance (own browser process), so the
 * invoice pool (JS off, every request aborted) and the designer pool (JS on,
 * requests fulfilled from memory) never share a browser.
 *
 * - Nothing launches at construction: the browser starts on the first job.
 * - Browser selection: `executablePath`, else `channel`, else on Windows the
 *   installed Edge, then Chrome, then Playwright's managed browser; other
 *   platforms use Playwright's managed browser.
 * - At most `concurrency` jobs run at once (FIFO semaphore). Optional
 *   `maxQueue` / `acquireTimeoutMs` make a saturated host fail fast with
 *   `unavailable(...)` instead of queueing without bound; both are off by
 *   default (the invoice renderer keeps its unbounded FIFO).
 * - Optional named `lanes`, each with its own slots and queue limits, so one
 *   kind of job cannot starve another (designer: proofs vs print files).
 * - Running as root forces `--no-sandbox` (Chromium refuses otherwise); in
 *   production that is logged as an error once per host, because a renderer
 *   escape then runs as root. Run the API as a non-root user.
 * - The browser closes after `idleCloseMs` idle and is relaunched
 *   transparently after a crash / disconnect (one retry per job).
 * - Optional `recycleAfterJobs`: the browser is closed after that many jobs
 *   once it is idle, which bounds the memory a long-lived process can
 *   accumulate (designer canvases are large).
 * - A launch failure surfaces as `unavailable(...)` (the owner's error type).
 *   Failed launches are not retried for `launchRetryAfterMs`, so a missing
 *   browser does not cost a launch attempt per job.
 */
import { Logger } from '@nestjs/common';
import type { Browser, LaunchOptions } from 'playwright-core';

export interface BrowserHostOptions {
  executablePath?: string;
  channel?: string;
  concurrency?: number;
  /** Launch timeout (ms). */
  timeoutMs?: number;
  idleCloseMs?: number;
  launchRetryAfterMs?: number;
  /** Extra Chromium command-line switches. */
  args?: string[];
  /** Close (and later relaunch) the browser after this many jobs; 0 = never. */
  recycleAfterJobs?: number;
  /** Waiting jobs of the default lane before new ones are refused; unset = unbounded. */
  maxQueue?: number;
  /** Max wait for a slot of the default lane (ms); unset/0 = no limit. */
  acquireTimeoutMs?: number;
  /** Named lanes with their own slots (used through `withBrowser(fn, lane)`). */
  lanes?: Record<string, BrowserLaneOptions>;
}

/** Slots and admission limits of one lane. */
export interface BrowserLaneOptions {
  concurrency: number;
  /** Waiting jobs before new ones are refused; unset = unbounded. */
  maxQueue?: number;
  /** Max wait for a slot (ms); unset/0 = no limit. */
  acquireTimeoutMs?: number;
}

/** How the owner names itself in logs and builds its "unavailable" error. */
export interface BrowserHostIdentity {
  /** Logger context, e.g. `ChromiumPdfRenderer`. */
  loggerName: string;
  /** Short label used in log lines, e.g. `PDF`. */
  label: string;
  /** What stops working when the browser cannot start (warning text). */
  unavailableNote: string;
  /** Builds the owner's "engine unavailable" error. */
  unavailable: (message: string, cause: unknown) => Error;
  /** True for errors built by `unavailable` (never retried by withBrowser). */
  isUnavailable: (err: unknown) => boolean;
}

const DEFAULTS = {
  concurrency: 2,
  timeoutMs: 15_000,
  idleCloseMs: 5 * 60_000,
  launchRetryAfterMs: 30_000,
  recycleAfterJobs: 0,
};

type PlaywrightCore = typeof import('playwright-core');

/** Why a semaphore refused a job: its queue is full or the wait timed out. */
export class SemaphoreBusyError extends Error {
  constructor(readonly reason: 'queue_full' | 'timeout') {
    super(
      reason === 'queue_full'
        ? 'Too many jobs are waiting'
        : 'Timed out waiting for a free slot',
    );
    this.name = 'SemaphoreBusyError';
  }
}

/** Minimal FIFO semaphore with an optional queue bound and wait timeout. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  get busy(): number {
    return this.active + this.waiters.length;
  }

  /** Jobs waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Takes a slot. With `maxQueue`, a job that would wait behind that many
   * others is refused at once; with `timeoutMs`, a waiting job gives up after
   * that long. Both throw SemaphoreBusyError and leave no slot taken.
   */
  async acquire(
    opts: { maxQueue?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    if (opts.maxQueue !== undefined && this.waiters.length >= opts.maxQueue) {
      throw new SemaphoreBusyError('queue_full');
    }
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.waiters.push(waiter);
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i < 0) return; // already handed a slot
          this.waiters.splice(i, 1);
          reject(new SemaphoreBusyError('timeout'));
        }, opts.timeoutMs);
        timer.unref?.();
      }
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

/** Rejects with `<what> timed out after <ms> ms` when `p` is not settled in time. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

type OptionalHostKeys =
  | 'executablePath'
  | 'channel'
  | 'args'
  | 'maxQueue'
  | 'acquireTimeoutMs'
  | 'lanes';

export class BrowserHost {
  private readonly logger: Logger;
  private readonly opts: Required<Omit<BrowserHostOptions, OptionalHostKeys>> &
    Pick<BrowserHostOptions, OptionalHostKeys>;
  /** Lane name -> slots and limits; `default` always exists. */
  private readonly lanes = new Map<
    string,
    { sem: Semaphore; opts: BrowserLaneOptions }
  >();
  private rootWarned = false;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastLaunchFailure: { at: number; error: unknown } | null = null;
  private jobsOnBrowser = 0;
  /** Number of launches so far (exposed for specs). */
  launchCount = 0;

  constructor(
    options: BrowserHostOptions,
    private readonly id: BrowserHostIdentity,
  ) {
    this.opts = { ...DEFAULTS, ...stripUndefined(options) };
    const lanes: Record<string, BrowserLaneOptions> = {
      default: {
        concurrency: this.opts.concurrency,
        maxQueue: this.opts.maxQueue,
        acquireTimeoutMs: this.opts.acquireTimeoutMs,
      },
      ...(this.opts.lanes ?? {}),
    };
    for (const [name, lane] of Object.entries(lanes)) {
      this.lanes.set(name, {
        sem: new Semaphore(Math.max(1, Math.floor(lane.concurrency))),
        opts: lane,
      });
    }
    this.logger = new Logger(id.loggerName);
  }

  /** Jobs running or waiting (all lanes). */
  get busy(): number {
    let n = 0;
    for (const l of this.lanes.values()) n += l.sem.busy;
    return n;
  }

  /** Jobs running or waiting in one lane. */
  laneBusy(lane: string): number {
    return this.lanes.get(lane)?.sem.busy ?? 0;
  }

  /** True while a browser process is connected. */
  get isRunning(): boolean {
    return !!this.browser?.isConnected();
  }

  /**
   * Runs `fn` with a connected browser inside a semaphore slot. When `fn`
   * fails and the browser is gone (crash, OOM kill), the browser is
   * relaunched and `fn` runs once more. `lane` picks the slots (unknown
   * names use `default`); a full queue or an acquire timeout throws
   * `unavailable(...)` without running `fn`.
   */
  async withBrowser<T>(
    fn: (browser: Browser) => Promise<T>,
    lane = 'default',
  ): Promise<T> {
    const l = this.lanes.get(lane) ?? this.lanes.get('default')!;
    try {
      await l.sem.acquire({
        maxQueue: l.opts.maxQueue,
        timeoutMs: l.opts.acquireTimeoutMs,
      });
    } catch (err) {
      if (!(err instanceof SemaphoreBusyError)) throw err;
      this.logger.warn(
        `${this.id.label} render refused (${lane} lane busy: ${err.reason})`,
      );
      throw this.id.unavailable(`${this.id.label} engine is busy`, err);
    }
    const sem = l.sem;
    this.clearIdleTimer();
    try {
      try {
        return await fn(await this.getBrowser());
      } catch (err) {
        // The browser died under us (crash, OOM kill): relaunch once.
        if (this.id.isUnavailable(err) || this.browser?.isConnected())
          throw err;
        this.logger.warn(
          `${this.id.label} render failed with a disconnected browser, relaunching: ${String(err)}`,
        );
        this.browser = null;
        return await fn(await this.getBrowser());
      }
    } finally {
      this.jobsOnBrowser++;
      sem.release();
      this.afterJob();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const recent = this.lastLaunchFailure;
    if (recent && Date.now() - recent.at < this.opts.launchRetryAfterMs) {
      throw this.id.unavailable(
        `${this.id.label} engine could not start (recent failure)`,
        recent.error,
      );
    }
    this.launching = this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  /** Launch candidates in order of preference. */
  private candidates(): LaunchOptions[] {
    const args: string[] = [...(this.opts.args ?? [])];
    // Chromium refuses to start sandboxed as root (common in containers).
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox');
      this.warnRootSandbox();
    }
    const base: LaunchOptions = { headless: true, args };
    if (this.opts.executablePath) {
      return [{ ...base, executablePath: this.opts.executablePath }];
    }
    if (this.opts.channel) return [{ ...base, channel: this.opts.channel }];
    if (process.platform === 'win32') {
      return [
        { ...base, channel: 'msedge' },
        { ...base, channel: 'chrome' },
        base,
      ];
    }
    return [base];
  }

  /**
   * Running as root disables Chromium's sandbox. It keeps working, but in
   * production that must be visible: logged as an error once per host.
   */
  private warnRootSandbox(): void {
    if (this.rootWarned) return;
    this.rootWarned = true;
    const msg =
      `${this.id.label} browser runs as root with --no-sandbox: a compromised ` +
      'renderer would run with root privileges. Run the API as a non-root user ' +
      '(see .env.example, "Chromium sandbox").';
    if (process.env.NODE_ENV === 'production') this.logger.error(msg);
    else this.logger.warn(msg);
  }

  private async launch(): Promise<Browser> {
    let pw: PlaywrightCore;
    try {
      // Loaded lazily so the API boots without touching the package.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pw = require('playwright-core') as PlaywrightCore;
    } catch (error) {
      this.lastLaunchFailure = { at: Date.now(), error };
      throw this.id.unavailable('playwright-core is not installed', error);
    }
    let lastError: unknown;
    for (const opts of this.candidates()) {
      try {
        const browser = await pw.chromium.launch({
          ...opts,
          timeout: this.opts.timeoutMs,
        });
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        this.browser = browser;
        this.lastLaunchFailure = null;
        this.jobsOnBrowser = 0;
        this.launchCount++;
        this.logger.log(
          `${this.id.label} browser launched (${opts.executablePath ?? opts.channel ?? 'playwright default'})`,
        );
        return browser;
      } catch (error) {
        lastError = error;
      }
    }
    this.lastLaunchFailure = { at: Date.now(), error: lastError };
    this.logger.warn(
      `${this.id.label} browser could not be launched; ${this.id.unavailableNote}: ${
        String((lastError as Error)?.message ?? lastError).split('\n')[0]
      }`,
    );
    throw this.id.unavailable(
      `${this.id.label} engine could not start`,
      lastError,
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private afterJob(): void {
    if (
      this.opts.recycleAfterJobs > 0 &&
      this.jobsOnBrowser >= this.opts.recycleAfterJobs &&
      this.busy === 0 &&
      this.browser
    ) {
      this.logger.log(
        `${this.id.label} browser recycled after ${this.jobsOnBrowser} jobs`,
      );
      void this.close();
      return;
    }
    this.scheduleIdleClose();
  }

  private scheduleIdleClose(): void {
    if (this.busy > 0 || !this.browser) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy === 0) void this.close();
    }, this.opts.idleCloseMs);
    this.idleTimer.unref?.();
  }

  /** Closes the browser (idle timeout / shutdown). Safe to call repeatedly. */
  async close(): Promise<void> {
    this.clearIdleTimer();
    const b = this.browser;
    this.browser = null;
    this.jobsOnBrowser = 0;
    if (b) await b.close().catch(() => undefined);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
