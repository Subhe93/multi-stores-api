/**
 * Boot-time checks (M5 W1-C, item 7): dev-only switches that must never be
 * set in production. The ops module logs each one as an ERROR at startup;
 * the process keeps running (an operator fixes the env and restarts).
 */

/** Dev-only switches and what they lift. */
export const PRODUCTION_FORBIDDEN_ENV: readonly {
  name: string;
  effect: string;
}[] = [
  {
    name: 'IMPORTER_ALLOW_PRIVATE_HOSTS',
    effect: 'lifts the importer SSRF address check',
  },
  {
    name: 'DESIGNER_RENDER_DUMP',
    effect: 'dumps render inputs/outputs to disk',
  },
  {
    name: 'DESIGNER_RENDER_REAL',
    effect: 'enables the real-browser render test mode',
  },
];

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/** Messages for each forbidden switch that is set (non-empty) in production. */
export function productionEnvViolations(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isProduction(env)) return [];
  return PRODUCTION_FORBIDDEN_ENV.filter(
    ({ name }) => (env[name] ?? '').trim() !== '',
  ).map(
    ({ name, effect }) =>
      `${name} is set in production (${effect}); unset it and restart`,
  );
}
