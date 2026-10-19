/*
 * @multi-stores/core consumption (M5.3). The personalization rules/evaluator
 * and the designer renderer live only in multi-stores-shared/packages/core;
 * this repo imports them (file: dependency). This spec checks that
 *   - the api resolves the package's CommonJS build,
 *   - that build was made from the current renderer source (RENDERER_SHA256
 *     is the sha256 of design-renderer.ts with LF line endings),
 *   - nobody re-added a copy of a package module to this repo.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { RENDERER_VERSION } from '@multi-stores/core/designer';
import { RENDERER_SHA256 } from '@multi-stores/core/designer/hash';

const CORE_DIR = path.dirname(
  require.resolve('@multi-stores/core/package.json'),
);
const posix = (p: string) => p.split(path.sep).join('/');

describe('@multi-stores/core package', () => {
  it('resolves the CommonJS build for the api', () => {
    expect(posix(require.resolve('@multi-stores/core/designer'))).toMatch(
      /packages\/core\/dist\/cjs\/designer\/design-renderer\.js$/,
    );
    expect(
      posix(require.resolve('@multi-stores/core/personalization/evaluator')),
    ).toMatch(/packages\/core\/dist\/cjs\/personalization\/evaluator\.js$/);
  });

  it('was built from the current renderer source (RENDERER_SHA256)', () => {
    const source = readFileSync(
      path.join(CORE_DIR, 'src/designer/design-renderer.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(source, 'utf8').digest('hex')).toBe(
      RENDERER_SHA256,
    );
  });

  it('exposes a semver RENDERER_VERSION', () => {
    expect(RENDERER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has no copy of a package module in this repo', () => {
    const guard = path.join(CORE_DIR, 'tools/check-no-copies.mjs');
    const repoRoot = path.resolve(__dirname, '../..');
    let problems = '';
    try {
      execFileSync(process.execPath, [guard, repoRoot], { stdio: 'pipe' });
    } catch (e) {
      // Non-zero exit: the offending files are listed on stderr.
      problems = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(problems).toBe('');
  });
});
