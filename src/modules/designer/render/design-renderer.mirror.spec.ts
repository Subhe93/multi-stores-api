/*
 * Mirror integrity (M4.2 D2 / §3.5): this file is a byte copy of
 * multi-stores-shared/src/designer/design-renderer.ts. The hash constant is
 * rewritten by multi-stores-shared/scripts/sync-designer-renderer.mjs.
 * Line endings are normalized to LF before hashing (core.autocrlf safe).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RENDERER_SHA256 } from './designer-renderer.hash';
import { RENDERER_VERSION } from './design-renderer';

const sha = (file: string) =>
  createHash('sha256')
    .update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');

describe('design-renderer mirror', () => {
  const mirror = path.join(__dirname, 'design-renderer.ts');

  it('matches RENDERER_SHA256 (run the sync script after editing the shared source)', () => {
    expect(sha(mirror)).toBe(RENDERER_SHA256);
  });

  it('equals the shared source when the sibling repo is checked out', () => {
    const shared = path.resolve(
      __dirname,
      '../../../../../multi-stores-shared/src/designer/design-renderer.ts',
    );
    if (!fs.existsSync(shared)) return;
    expect(sha(shared)).toBe(sha(mirror));
  });

  it('exposes a semver RENDERER_VERSION', () => {
    expect(RENDERER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
