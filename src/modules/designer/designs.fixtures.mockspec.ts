/**
 * Shared fixtures of the WP4 designer specs: one store with a published
 * template (a text element "namn", an image slot "foto"), a linked product,
 * and service doubles for the WP3 asset/url services.
 */
import { DesignAssetKind } from '@prisma/client';
import type { DesignerAssetsService } from './designer-assets.service';
import type { DesignerUrlsService } from './designer-urls';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import { blankTemplateSpec } from './designs.util';
import type { TemplateSpecV1 } from './render/design-renderer';
import {
  emptyDb,
  fakeWp4Prisma,
  matches,
  type WP4Db,
} from './designs-fake-prisma.mockspec';

export const STORE = '11111111-1111-4111-8111-111111111111';
export const OTHER_STORE = '11111111-1111-4111-8111-999999999999';
export const CREATOR = '22222222-2222-4222-8222-222222222222';
export const PRODUCT = '33333333-3333-4333-8333-333333333333';
export const PLAIN_PRODUCT = '33333333-3333-4333-8333-444444444444';
export const TEMPLATE = '44444444-4444-4444-8444-444444444444';
export const V1 = '55555555-5555-4555-8555-555555555551';
export const V2 = '55555555-5555-4555-8555-555555555552';
export const CUSTOMER = '66666666-6666-4666-8666-666666666666';
export const OTHER_CUSTOMER = '66666666-6666-4666-8666-777777777777';
export const BG = '77777777-7777-4777-8777-777777777771';
export const BG_PRINT = '77777777-7777-4777-8777-777777777772';
export const FONT = '77777777-7777-4777-8777-777777777773';

export function templateSpec(): TemplateSpecV1 {
  const spec = blankTemplateSpec();
  spec.fonts = [
    { family: 'Montserrat', weight: 600, style: 'normal', asset_id: FONT },
  ];
  spec.surfaces[0].background = {
    color: '#ffffff',
    fit: 'stretch',
    web: { asset_id: BG, width: 1000, height: 1400 },
    print: { asset_id: BG_PRINT, width: 3000, height: 4200 },
  };
  spec.surfaces[0].elements = [
    {
      id: 'foto',
      type: 'image_slot',
      x: 50,
      y: 100,
      w: 400,
      h: 400,
      rot: 0,
      z: 1,
      locked: false,
      label: { sv: 'Foto' },
      placeholder: { sv: 'Ladda upp bild' },
      shape: 'ellipse',
      radius: 0,
      border_color: '#cccccc',
      required: true,
      adj_limits: { zoom: [1, 3], rot: [-180, 180] },
      default_adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
    },
    {
      id: 'namn',
      type: 'text',
      x: 90,
      y: 40,
      w: 300,
      h: 52,
      rot: 0,
      z: 3,
      locked: false,
      label: { sv: 'Namn', en: 'Name' },
      placeholder: { sv: 'Namn' },
      default_text: '',
      font: { family: 'Montserrat', weight: 600, style: 'normal' },
      size: 73,
      color: '#ffffff',
      align: 'center',
      transform: 'none',
      fit: { mode: 'shrink', step: 0.5, min: 6, pad_ref_px: 8 },
      inset: 4,
      editable: true,
      required: true,
      max_length: 10,
      direction: 'ltr',
    },
    {
      id: 'klass',
      type: 'text',
      x: 90,
      y: 600,
      w: 300,
      h: 40,
      rot: 0,
      z: 3,
      locked: false,
      label: { sv: 'Klass' },
      placeholder: { sv: 'Klass' },
      default_text: 'Klass 9A',
      font: { family: 'Montserrat', weight: 600, style: 'normal' },
      size: 40,
      color: '#ffffff',
      align: 'center',
      transform: 'uppercase',
      fit: { mode: 'shrink', step: 0.5, min: 6, pad_ref_px: 8 },
      inset: 4,
      editable: true,
      required: false,
      max_length: 40,
      direction: 'ltr',
    },
  ];
  return spec;
}

export function seededDb(): WP4Db {
  const db = emptyDb();
  db.store.push(
    { id: STORE, creator_id: CREATOR, slug: 'namez' },
    { id: OTHER_STORE, creator_id: 'other-creator', slug: 'other' },
  );
  db.product.push(
    { id: PRODUCT, creator_id: CREATOR, status: 'PUBLISHED' },
    { id: PLAIN_PRODUCT, creator_id: CREATOR, status: 'PUBLISHED' },
  );
  db.designTemplate.push({
    id: TEMPLATE,
    store_id: STORE,
    name: 'Student',
    status: 'PUBLISHED',
    current_version_id: V1,
    source: 'native',
    external_ref: null,
  });
  db.designTemplateVersion.push(
    { id: V1, template_id: TEMPLATE, version: 1, spec: templateSpec() },
    { id: V2, template_id: TEMPLATE, version: 2, spec: templateSpec() },
  );
  db.productDesigner.push({
    product_id: PRODUCT,
    store_id: STORE,
    template_id: TEMPLATE,
    enabled: true,
    addons: {},
  });
  db.customer.push(
    { id: CUSTOMER, user_id: 'user-1' },
    { id: OTHER_CUSTOMER, user_id: 'user-2' },
  );
  db.designAsset.push(
    asset(BG, DesignAssetKind.TEMPLATE_BG_WEB, 1000, 1400, 'image/webp'),
    asset(BG_PRINT, DesignAssetKind.TEMPLATE_BG_PRINT, 3000, 4200, 'image/png'),
    asset(FONT, DesignAssetKind.FONT, 0, 0, 'font/woff2'),
  );
  return db;
}

export function asset(
  id: string,
  kind: DesignAssetKind,
  width: number,
  height: number,
  mime = 'image/jpeg',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    store_id: STORE,
    kind,
    design_id: null,
    private_key: `designer/${STORE}/2026/x/${id}.jpg`,
    preview_key: null,
    public_url: null,
    mime,
    width,
    height,
    bytes: 100,
    sha256: `sha-${id.slice(0, 8)}`,
    meta: null,
    created_at: new Date(),
    purged_at: null,
    ...extra,
  };
}

export function doubles(
  db: WP4Db,
  opts: { appOn?: boolean; settings?: Record<string, unknown> } = {},
) {
  const prisma = fakeWp4Prisma(db);
  const storeApps = {
    isEnabled: jest.fn((_s: string, key: string) =>
      Promise.resolve(key === 'designer' ? opts.appOn !== false : false),
    ),
    getSettings: jest.fn(() =>
      Promise.resolve(opts.appOn === false ? null : (opts.settings ?? {})),
    ),
  };
  let n = 0;
  const assets = {
    findOwnedAssets: jest.fn(
      (storeId: string, ids: string[], kinds?: string[]) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const r of db.designAsset) {
          if (
            ids.includes(r.id as string) &&
            r.store_id === storeId &&
            !r.purged_at &&
            (!kinds || kinds.includes(r.kind as string))
          ) {
            out.set(r.id as string, r);
          }
        }
        return Promise.resolve(out);
      },
    ),
    storePhoto: jest.fn(
      (storeId: string, _buf: Buffer, o: { design_id?: string | null }) => {
        const id = `88888888-8888-4888-8888-${String(++n).padStart(12, '0')}`;
        const row = asset(
          id,
          DesignAssetKind.CUSTOMER_PHOTO,
          2400,
          3600,
          'image/jpeg',
          {
            store_id: storeId,
            design_id: o.design_id ?? null,
            preview_key: 'p',
          },
        );
        db.designAsset.push(row);
        return Promise.resolve(row);
      },
    ),
    assetView: jest.fn((a: { id: string }) => ({
      id: a.id,
      preview_url: `/api/designer/files/preview-${a.id}`,
    })),
    purgeAssetFiles: jest.fn((a: { id: string }) => {
      const r = db.designAsset.find((x) => matches(x, { id: a.id }));
      if (r) r.purged_at = new Date();
      return Promise.resolve();
    }),
  };
  const urls = {
    signedPath: jest.fn(
      (kind: string, id: string) => `/api/designer/files/${kind}-${id}`,
    ),
    absolute: jest.fn((p: string) => `https://api.test${p}`),
  };
  return {
    prisma,
    storeApps: storeApps as unknown as StoreAppsService & typeof storeApps,
    assets: assets as unknown as DesignerAssetsService & typeof assets,
    urls: urls as unknown as DesignerUrlsService & typeof urls,
  };
}
