import { StoreType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { DesignerFontsService } from './designer-fonts.service';
import { designerErrorCode } from './designer-errors';
import {
  DesignerTemplatesService,
  NPP_FALLBACK_PRESET_KEY,
} from './designer-templates.service';
import { StorefrontService } from '../storefront/storefront.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';
import {
  BG,
  BG_PRINT,
  FONT,
  PLAIN_PRODUCT,
  PRODUCT,
  STORE,
  TEMPLATE,
  V1,
  V2,
  doubles,
  seededDb,
  templateSpec,
} from './designs.fixtures.mockspec';

// M4.2 WP4 §4.3 creator templates + product link, §4.1 storefront block.

function build(opts: { appOn?: boolean } = {}) {
  const db = seededDb();
  const d = doubles(db, opts);
  const fonts = {
    fontsForSpec: jest.fn(
      (_s: string, spec: { fonts?: { asset_id: string }[] }) =>
        Promise.resolve(
          (spec.fonts ?? [])
            .filter((f) => f.asset_id === FONT)
            .map(() => ({
              asset_id: FONT,
              family: 'Montserrat',
              weight: 600,
              style: 'normal',
              url: `/api/designer/fonts/${FONT}.woff2`,
            })),
        ),
    ),
  };
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const service = new DesignerTemplatesService(
    d.prisma as unknown as PrismaService,
    d.storeApps,
    d.assets,
    fonts as unknown as DesignerFontsService,
    revalidation as unknown as RevalidationService,
  );
  return { db, service, fonts, revalidation, ...d };
}

async function errOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { getResponse(): Record<string, unknown> };
  }
  throw new Error('expected an error');
}

describe('DesignerTemplatesService (M4.2 WP4)', () => {
  describe('validateTemplateSpec', () => {
    it('fills AssetRef sizes from the stored assets', async () => {
      const { service } = build();
      const spec = templateSpec();
      spec.surfaces[0].background.web = { asset_id: BG, width: 1, height: 1 };
      const out = await service.validateTemplateSpec(STORE, spec);
      expect(out.surfaces[0].background.web).toEqual({
        asset_id: BG,
        width: 1000,
        height: 1400,
      });
    });

    it('structural errors, foreign / wrong-kind assets and unknown fonts → 400 DESIGNER_TEMPLATE_INVALID {errors}', async () => {
      const { service } = build();
      const e1 = await errOf(
        service.validateTemplateSpec(STORE, { schema: 'x' }),
      );
      expect(e1.getResponse()).toMatchObject({
        code: 'DESIGNER_TEMPLATE_INVALID',
      });
      expect((e1.getResponse().errors as unknown[]).length).toBeGreaterThan(0);

      const spec = templateSpec();
      spec.surfaces[0].background.web = {
        asset_id: BG_PRINT,
        width: 1,
        height: 1,
      };
      spec.fonts[0].weight = 700;
      spec.surfaces[0].elements.forEach((el) => {
        if (el.type === 'text') el.font.weight = 700;
      });
      const e2 = await errOf(service.validateTemplateSpec(STORE, spec));
      expect(e2.getResponse().errors).toEqual([
        { path: 'surfaces[0].background.web', rule: 'asset_kind' },
        { path: 'fonts[0]', rule: 'font' },
      ]);

      const spec3 = templateSpec();
      spec3.surfaces[0].background.print = {
        asset_id: '77777777-7777-4777-8777-000000000000',
        width: 1,
        height: 1,
      };
      const e3 = await errOf(service.validateTemplateSpec(STORE, spec3));
      expect(e3.getResponse().errors).toEqual([
        { path: 'surfaces[0].background.print', rule: 'asset' },
      ]);
    });
  });

  it('create: blank 500×700 DRAFT with version 1', async () => {
    const { service, db } = build();
    const t = await service.create(STORE, { name: '  Ny ' }, 'user-1');
    expect(t).toMatchObject({
      name: 'Ny',
      status: 'DRAFT',
      current_version_id: null,
      current_spec: null,
    });
    const v = db.designTemplateVersion.find((x) => x.template_id === t.id)!;
    expect(v).toMatchObject({ version: 1, created_by: 'user-1' });
    expect((v.spec as { width: number }).width).toBe(500);
    expect(v.spec_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('versions: next number, immutable rows; publish sets current + PUBLISHED and revalidates', async () => {
    const { service, db, revalidation } = build();
    const v = await service.addVersion(STORE, TEMPLATE, templateSpec(), 'u');
    expect(v.version).toBe(3);
    await service.publish(STORE, TEMPLATE, V2);
    expect(db.designTemplate[0]).toMatchObject({
      current_version_id: V2,
      status: 'PUBLISHED',
    });
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith(STORE);
    expect(
      designerErrorCode(await errOf(service.publish(STORE, TEMPLATE, PRODUCT))),
    ).toBe('DESIGNER_TEMPLATE_NOT_FOUND');
  });

  it('delete: 409 IN_USE while a product is linked', async () => {
    const { service, db } = build();
    const e = await errOf(service.remove(STORE, TEMPLATE));
    expect(e.getResponse()).toMatchObject({ code: 'DESIGNER_TEMPLATE_IN_USE' });
    db.productDesigner.length = 0;
    await expect(service.remove(STORE, TEMPLATE)).resolves.toEqual({
      deleted: true,
    });
  });

  describe('product link + fallback-field removal (X28)', () => {
    function withFallbackFields(db: ReturnType<typeof seededDb>) {
      db.productCustomField.push(
        {
          id: 'f-namn',
          product_id: PLAIN_PRODUCT,
          preset_key: NPP_FALLBACK_PRESET_KEY,
          is_required: true,
        },
        {
          id: 'f-klass',
          product_id: PLAIN_PRODUCT,
          preset_key: NPP_FALLBACK_PRESET_KEY,
          is_required: true,
        },
        {
          id: 'f-own',
          product_id: PLAIN_PRODUCT,
          preset_key: null,
          is_required: false,
        },
      );
    }

    it('a disabled link keeps the launch fields', async () => {
      const { service, db } = build();
      withFallbackFields(db);
      const res = await service.putProductLink(STORE, PLAIN_PRODUCT, {
        enabled: false,
        template_id: TEMPLATE,
      });
      expect(res.removed_fallback_fields).toBe(0);
      expect(db.productCustomField).toHaveLength(3);
      expect(res.link).toMatchObject({ enabled: false, template_id: TEMPLATE });
    });

    it('enabling deletes only the npp_fallback fields, in one transaction', async () => {
      const { service, db, prisma } = build();
      withFallbackFields(db);
      const res = await service.putProductLink(STORE, PLAIN_PRODUCT, {
        enabled: true,
        template_id: TEMPLATE,
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(res.removed_fallback_fields).toBe(2);
      expect(db.productCustomField.map((f) => f.id)).toEqual(['f-own']);
      expect(res).toMatchObject({
        fallback_field_count: 0,
        required_field_count: 0,
      });
    });

    it('enabling needs a PUBLISHED template; foreign products are 404', async () => {
      const { service, db } = build();
      db.designTemplate[0].status = 'DRAFT';
      expect(
        designerErrorCode(
          await errOf(
            service.putProductLink(STORE, PLAIN_PRODUCT, {
              enabled: true,
              template_id: TEMPLATE,
            }),
          ),
        ),
      ).toBe('DESIGNER_TEMPLATE_MISMATCH');
      db.product[1].creator_id = 'someone-else';
      expect(
        designerErrorCode(
          await errOf(
            service.putProductLink(STORE, PLAIN_PRODUCT, {
              enabled: false,
              template_id: TEMPLATE,
            }),
          ),
        ),
      ).toBe('DESIGNER_DESIGN_NOT_FOUND');
    });
  });

  describe('storefront block (§4.1)', () => {
    it('app off: null after one cached isEnabled, no query', async () => {
      const { service, prisma } = build({ appOn: false });
      await expect(service.storefrontBlock(STORE, PRODUCT)).resolves.toBeNull();
      expect(prisma.productDesigner.findUnique).not.toHaveBeenCalled();
    });

    it('app on + enabled link: public spec (print background stripped), fonts, settings', async () => {
      const { service } = build();
      const block = await service.storefrontBlock(STORE, PRODUCT);
      expect(block).toMatchObject({
        template_id: TEMPLATE,
        template_version_id: V1,
        fonts: [
          {
            family: 'Montserrat',
            weight: 600,
            style: 'normal',
            url: `/api/designer/fonts/${FONT}.woff2`,
          },
        ],
        settings: { max_upload_mb: 25, min_effective_dpi_warning: 100 },
      });
      const bg = (
        block!.spec_public as {
          surfaces: { background: Record<string, unknown> }[];
        }
      ).surfaces[0].background;
      expect(bg.print).toBeUndefined();
      expect(bg.web).toEqual({
        asset_id: BG,
        width: 1000,
        height: 1400,
        url: `/api/designer/assets/${BG}.webp`,
      });
      expect(JSON.stringify(block)).not.toContain(BG_PRINT);
    });

    it('disabled link / unpublished template / unlinked product: null', async () => {
      const { service, db } = build();
      await expect(
        service.storefrontBlock(STORE, PLAIN_PRODUCT),
      ).resolves.toBeNull();
      db.designTemplate[0].status = 'ARCHIVED';
      await expect(service.storefrontBlock(STORE, PRODUCT)).resolves.toBeNull();
      db.designTemplate[0].status = 'PUBLISHED';
      db.productDesigner[0].enabled = false;
      await expect(service.storefrontBlock(STORE, PRODUCT)).resolves.toBeNull();
    });
  });

  describe('StorefrontService.getProduct G0', () => {
    function storefront(
      designer: DesignerTemplatesService | undefined,
      appOn: boolean,
    ) {
      const product = {
        id: PRODUCT,
        creator_id: 'c1',
        provider_id: null,
        base_price: 299,
        compare_at_price: null,
        variant_option_config: null,
        tax_class_id: null,
        tax_exempt: false,
        translations: [],
        images: [],
        attributes: [],
        variants: [],
        tags: [],
        category: null,
        creator_categories: [],
        custom_fields: [],
        faqs: [],
        shipping_profile: null,
      };
      const prisma = {
        store: {
          findUnique: jest.fn(() =>
            Promise.resolve({
              id: STORE,
              slug: 'namez',
              creator_id: 'c1',
              store_type: StoreType.INDEPENDENT,
              currency: 'SEK',
              creator: { id: 'c1' },
            }),
          ),
        },
        product: { findFirst: jest.fn(() => Promise.resolve(product)) },
        promotion: { findMany: jest.fn(() => Promise.resolve([])) },
        bundle: { findMany: jest.fn(() => Promise.resolve([])) },
      };
      const storeApps = {
        isEnabled: jest.fn((_s: string, k: string) =>
          Promise.resolve(k === 'designer' && appOn),
        ),
        getSettings: jest.fn(() => Promise.resolve({})),
      };
      return new StorefrontService(
        prisma as unknown as PrismaService,
        storeApps as unknown as StoreAppsService,
        {
          resolve: jest.fn(() => Promise.resolve(null)),
        } as unknown as MarketsContextService,
        {} as MarketPricingService,
        {} as TaxService,
        undefined,
        designer,
      );
    }

    it('app off: payload byte-identical to a build without the designer', async () => {
      const off = build({ appOn: false });
      const withSvc = await storefront(off.service, false).getProduct(
        'namez',
        'p',
        'sv',
      );
      const without = await storefront(undefined, false).getProduct(
        'namez',
        'p',
        'sv',
      );
      expect(JSON.stringify(withSvc)).toBe(JSON.stringify(without));
      expect(withSvc).not.toHaveProperty('designer');
    });

    it('app on + linked: the designer key is added', async () => {
      const on = build();
      const payload = (await storefront(on.service, true).getProduct(
        'namez',
        'p',
        'sv',
      )) as Record<string, unknown>;
      expect(payload.designer).toMatchObject({ template_id: TEMPLATE });
    });
  });
});
