import { DesignAssetKind } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { DesignerAssetsService } from './designer-assets.service';
import type { DesignerFontsService } from './designer-fonts.service';
import type { DesignerRenderService } from './designer-render.service';
import {
  DesignerTemplatesService,
  TEMPLATE_THUMB_PX_PER_MM,
} from './designer-templates.service';
import { DesignerRenderUnavailableError } from './render/designer-chromium.host';

// WP4 gap closed with WP6/WP10: publishing renders the version's defaults
// as a TEMPLATE_THUMB asset in the background and stores its public path as
// `thumbnail_url`. Engine off or a 503 leaves the old thumbnail (null).

function build(opts: { enabled?: boolean; fail?: Error } = {}) {
  const prisma = {
    designTemplateVersion: {
      findFirst: jest.fn(() =>
        Promise.resolve({ spec: { width: 500, height: 700 } }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
  const render = {
    engineEnabled: opts.enabled !== false,
    renderCanvas: jest.fn(() =>
      opts.fail
        ? Promise.reject(opts.fail)
        : Promise.resolve({
            data: Buffer.from('webp'),
            width: 500,
            height: 700,
          }),
    ),
  };
  const assets = {
    storeTemplateAsset: jest.fn(() =>
      Promise.resolve({ asset: { url: '/api/designer/assets/t1.webp' } }),
    ),
  };
  const service = new DesignerTemplatesService(
    prisma as unknown as PrismaService,
    {} as StoreAppsService,
    assets as unknown as DesignerAssetsService,
    {} as DesignerFontsService,
    {} as RevalidationService,
    render as unknown as DesignerRenderService,
  );
  return { service, prisma, render, assets };
}

describe('DesignerTemplatesService.renderThumbnail', () => {
  it('renders the defaults and stores the TEMPLATE_THUMB path', async () => {
    const t = build();
    expect(await t.service.renderThumbnail('s1', 't1', 'v1')).toBe(
      '/api/designer/assets/t1.webp',
    );
    expect(t.render.renderCanvas).toHaveBeenCalledWith(
      's1',
      { width: 500, height: 700 },
      { v: 1, texts: {}, photos: {} },
      expect.objectContaining({
        mode: 'proof',
        scale: TEMPLATE_THUMB_PX_PER_MM,
        type: 'image/webp',
      }),
    );
    expect(t.assets.storeTemplateAsset).toHaveBeenCalledWith('s1', {
      buffer: Buffer.from('webp'),
      kind: DesignAssetKind.TEMPLATE_THUMB,
      template_id: 't1',
    });
    expect(t.prisma.designTemplateVersion.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { thumbnail_url: '/api/designer/assets/t1.webp' },
    });
  });

  it('503 / render failure degrades to null and keeps the old thumbnail', async () => {
    const t = build({ fail: new DesignerRenderUnavailableError('busy') });
    expect(await t.service.renderThumbnail('s1', 't1', 'v1')).toBeNull();
    expect(t.prisma.designTemplateVersion.update).not.toHaveBeenCalled();
  });

  it('engine off: nothing is rendered', async () => {
    const t = build({ enabled: false });
    expect(await t.service.renderThumbnail('s1', 't1', 'v1')).toBeNull();
    expect(t.render.renderCanvas).not.toHaveBeenCalled();
  });
});
