/**
 * Browser selection shared by the invoice and designer renderers (M5 W1-C):
 * `CHROMIUM_PATH` / `CHROMIUM_CHANNEL` are the common names; the legacy
 * per-renderer names (`INVOICE_PDF_CHROMIUM_PATH`, `DESIGNER_CHROMIUM_PATH`,
 * `INVOICE_PDF_BROWSER_CHANNEL`, `DESIGNER_BROWSER_CHANNEL`) keep winning
 * when set, so an environment that only sets the legacy names behaves
 * exactly as before.
 */

export const CHROMIUM_PATH_ENV = 'CHROMIUM_PATH';
export const CHROMIUM_CHANNEL_ENV = 'CHROMIUM_CHANNEL';

function firstNonEmpty(values: (string | undefined)[]): string | undefined {
  return values.map((v) => v?.trim()).find((v) => !!v) || undefined;
}

/** Executable path: the legacy names in order, then CHROMIUM_PATH. */
export function chromiumExecutablePath(
  env: NodeJS.ProcessEnv,
  ...legacyNames: string[]
): string | undefined {
  return firstNonEmpty([
    ...legacyNames.map((n) => env[n]),
    env[CHROMIUM_PATH_ENV],
  ]);
}

/** Browser channel (msedge, chrome, …): the legacy names, then CHROMIUM_CHANNEL. */
export function chromiumChannel(
  env: NodeJS.ProcessEnv,
  ...legacyNames: string[]
): string | undefined {
  return firstNonEmpty([
    ...legacyNames.map((n) => env[n]),
    env[CHROMIUM_CHANNEL_ENV],
  ]);
}
