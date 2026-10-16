import { DesignAssetKind } from '@prisma/client';
import { isValidPrivateStorageKey } from '../../common/storage/private-file-storage';
import {
  ASSET_KIND_DIR,
  DESIGNER_FILE_DIRS,
  DESIGNER_FILE_EXTS,
  designerStorageKey,
  extForMime,
  extOfKey,
  MIME_BY_EXT,
} from './designer-assets.keys';

const STORE = '22222222-2222-4222-8222-222222222222';
const ID = '11111111-1111-4111-8111-111111111111';
const AT = new Date(Date.UTC(2026, 9, 16));

describe('designer storage keys (C10 namespace designer/)', () => {
  it('builds designer/<store>/<yyyy>/<dir>/<id>.<ext>', () => {
    expect(designerStorageKey(STORE, 'bg-print', ID, 'png', { at: AT })).toBe(
      `designer/${STORE}/2026/bg-print/${ID}.png`,
    );
    expect(
      designerStorageKey(STORE, 'print', ID, 'png', {
        at: AT,
        suffix: 'front',
      }),
    ).toBe(`designer/${STORE}/2026/print/${ID}-front.png`);
  });

  it('every dir × ext combination passes the private storage pattern', () => {
    for (const dir of DESIGNER_FILE_DIRS) {
      for (const ext of DESIGNER_FILE_EXTS) {
        expect(
          isValidPrivateStorageKey(designerStorageKey(STORE, dir, ID, ext)),
        ).toBe(true);
      }
    }
    for (const kind of Object.values(DesignAssetKind)) {
      expect(DESIGNER_FILE_DIRS).toContain(ASSET_KIND_DIR[kind]);
    }
  });

  it('the pattern rejects traversal, foreign dirs and extensions', () => {
    for (const bad of [
      `designer/${STORE}/2026/photo/../${ID}.png`,
      `designer/${STORE}/2026/other/${ID}.png`,
      `designer/${STORE}/2026/photo/${ID}.svg`,
      `designer/${STORE}/2026/photo/${ID}.png.exe`,
      `designer/not-a-store/2026/photo/${ID}.png`,
      `designer/${STORE}/26/photo/${ID}.png`,
      `designer/${STORE}/2026/print/${ID}-FRONT.png`,
    ]) {
      expect(isValidPrivateStorageKey(bad)).toBe(false);
    }
  });

  it('refuses non-uuid ids and bad suffixes', () => {
    expect(() => designerStorageKey('x', 'photo', ID, 'jpg')).toThrow();
    expect(() => designerStorageKey(STORE, 'photo', '../x', 'jpg')).toThrow();
    expect(() =>
      designerStorageKey(STORE, 'print', ID, 'png', { suffix: 'a/b' }),
    ).toThrow();
  });

  it('maps mime types and key extensions', () => {
    for (const ext of DESIGNER_FILE_EXTS) {
      expect(extForMime(MIME_BY_EXT[ext])).toBe(ext);
    }
    expect(extForMime('image/gif')).toBeNull();
    expect(extOfKey(`designer/${STORE}/2026/proof/${ID}.webp`)).toBe('webp');
    expect(extOfKey('x.gif')).toBeNull();
  });
});
