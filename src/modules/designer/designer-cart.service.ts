/**
 * Designer lines in the cart, the quote and the order (M4.2 WP4, §4.2,
 * M4-INTEGRATION C29 step 2).
 *
 * A line is a designer line when it carries a `design_id`, or when its
 * product has an enabled `ProductDesigner` link while the app is on (then a
 * missing design is 400 DESIGNER_DESIGN_REQUIRED — this also closes the
 * theme add-to-cart bypass). A designer line carries NO custom field values:
 * callers drop whatever was sent and skip the field rules.
 *
 * Rules (§4.2):
 *  1. design_id while the app is off → 400 DESIGNER_NOT_ENABLED;
 *  2. linked product without design → 400 DESIGNER_DESIGN_REQUIRED;
 *  3. the design belongs to this store and product, its template version to
 *     the product's linked template (any version), the owner matches, and it
 *     is not ORDERED (see `DesignerLineMode` for where each check applies);
 *  4. `validateState(requireComplete:true)` + photo ownership.
 * M5.5 add-ons: the line's per-unit `priceDelta` is the sum of the design's
 * selected ENABLED add-ons, priced from the product's CURRENT config in the
 * base currency (designer-addons.ts; callers convert it for a market).
 * Products without enabled add-ons keep a delta of 0 (G0).
 *
 * Stores without the app: one cached `isEnabled` per quote/order, and on a
 * server-cart add one primary-key lookup of `ProductDesigner` — nothing else.
 *
 * A product link is ACTIVE only when it is enabled AND its template is
 * PUBLISHED with a current version (same rule as the storefront block); an
 * archived / unpublished template turns its products back into ordinary
 * products, and designed lines of it are no longer orderable.
 * An ORDERED design is never orderable again (any mode): the storefront
 * duplicates it (`POST …/designs/:id/duplicate`).
 */
import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DesignAssetKind,
  DesignStatus,
  Prisma,
  type Design,
  type DesignAsset,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { DesignerAssetsService } from './designer-assets.service';
import { designerErrors, type DesignerErrorCode } from './designer-errors';
import { originalsPurgeAt } from './designer-retention.service';
import { normalizeDesignerSettings } from './designer-settings';
import { DESIGNER_LINK_TTL, DesignerUrlsService } from './designer-urls';
import {
  DesignsService,
  designTokenMatches,
  slotMap,
  type DesignLineRef,
  type DesignVersionRow,
} from './designs.service';
import {
  DesignerRenderService,
  printFileExtras,
  type PrintFile,
} from './designer-render.service';
import {
  addonDetailText,
  addonLabel,
  orderAddonsCurrencyOf,
  orderAddonsOf,
  priceAddons,
  type PricedAddon,
} from './designer-addons';
import {
  designProofSha,
  designTextValues,
  isUuid,
  specAssetUses,
  type DesignTextValue,
} from './designs.util';
import {
  effectiveDpi,
  RENDERER_VERSION,
  validateState,
  type DesignStateV1,
  type I18n,
  type TemplateSpecV1,
} from './render/design-renderer';

/**
 * Where a line is checked (an ORDERED design is locked in every mode):
 * - `cart`: server-cart add / guest migration. Owner must match; a guest
 *   design needs its token and is then CLAIMED by the customer.
 * - `order`: order from the server cart. Owner must match (claimed at add,
 *   or the token).
 * - `quote`: pricing. A public quote checks only a token that is sent. An
 *   order-bound quote (Kustom session pricing, `verifiedDesignIds` given)
 *   requires every design to be one the session verified, or owned by
 *   `customerId`.
 * - `snapshot`: an order from a stored checkout snapshot (Kustom validation
 *   callback): only the designs the session verified when it stored the
 *   lines (`verifiedDesignIds`) are trusted.
 */
export type DesignerLineMode = 'cart' | 'order' | 'quote' | 'snapshot';

/** The ids of a line (cart DTO, cart row, snapshot line). */
export interface DesignerLineInput {
  product_id?: string | null;
  custom_product_id?: string | null;
  variant_id?: string | null;
  design_id?: string | null;
  design_token?: string | null;
}

/** A validated designer line. */
export interface DesignerLine {
  design: Design;
  version: DesignVersionRow;
  spec: TemplateSpecV1;
  /** Normalized, complete state (photo sizes from the asset rows). */
  state: DesignStateV1;
  /** Photo asset per slot id. */
  photos: Map<string, DesignAsset>;
  /** Per-unit designer delta in the base currency (M5.5 add-ons; 0 without). */
  priceDelta: number;
  /** The priced add-ons behind `priceDelta` (base currency, per unit). */
  addons: PricedAddon[];
}

/** One `source:'DESIGN'` value row input (C19). */
export interface DesignTextInput {
  element_id: string;
  label: I18n;
  value: string;
}

/** What a cart read shows for a designer line. */
export interface CartDesignView {
  id: string;
  text_values: { element_id: string; label: string; value: string }[];
  editable: boolean;
  proof_url: string | null;
  /** Product slug in the request locale (link back to the editor). */
  product_slug: string | null;
  /**
   * M5.5: the selected add-ons, priced in the BASE currency per unit (the
   * cart converts them for a market); absent without any.
   */
  addons?: CartDesignAddon[];
  /** Set when the design can no longer be ordered (checkout would fail). */
  invalid?: true;
  /** The error checkout would answer (`DESIGNER_*`), with `invalid`. */
  invalid_code?: DesignerErrorCode;
}

/** One add-on of a cart line's design (`label` resolved to the request locale). */
export interface CartDesignAddon {
  key: string;
  type: 'toggle' | 'quantity';
  label: string;
  qty: number;
  unit_price: number;
  amount: number;
  /** Readable detail ("+149 kr", "× 2 (+358 kr)"), set by the cart in its currency. */
  text?: string;
}

/** Cart / quote reads refresh a design's `updated_at` at most this often. */
export const DESIGN_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The active template of a product link, or null (see the file header). */
export function activeLinkTemplateId(
  link:
    | {
        enabled: boolean;
        template_id: string;
        template?: {
          status: string;
          current_version_id: string | null;
        } | null;
      }
    | null
    | undefined,
): string | null {
  if (!link?.enabled || !link.template) return null;
  if (link.template.status !== 'PUBLISHED') return null;
  if (!link.template.current_version_id) return null;
  return link.template_id;
}

const LINK_TEMPLATE_SELECT = {
  select: { status: true, current_version_id: true },
} as const;

type LoadedDesign = Design & { template_version: DesignVersionRow };

@Injectable()
export class DesignerCartService {
  private readonly logger = new Logger(DesignerCartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly designs: DesignsService,
    private readonly assets: DesignerAssetsService,
    private readonly urls: DesignerUrlsService,
    // WP5 render service (proofs, signed order proofs); optional so a test
    // or a build without the render engine still validates lines.
    @Optional() private readonly render?: DesignerRenderService,
  ) {}

  /**
   * §5.4: after a server-cart add the design's proof is rendered in the
   * background (not awaited by the caller). Reused when the state did not
   * change; an unavailable render engine (503) or any failure is only
   * logged, so a cart add never fails because of the proof.
   */
  ensureProof(designId: string): void {
    if (!this.render || !isUuid(designId)) return;
    this.render.renderDesignProof(designId).catch((e: unknown) => {
      this.logger.debug(
        `proof for design ${designId} not rendered: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  // ── Errors ────────────────────────────────────────────────────────────────

  private err(
    kind: 'badRequest' | 'notFound' | 'forbidden' | 'conflict',
    code: DesignerErrorCode,
    message: string,
    ref: DesignLineRef = {},
  ): HttpException {
    const e = designerErrors[kind](code, message);
    const body = e.getResponse() as Record<string, unknown>;
    return new HttpException({ ...body, ...ref }, e.getStatus());
  }

  // ── Classification + validation ───────────────────────────────────────────

  /**
   * Quote / order: one entry per line, the validated designer line or null
   * (an ordinary line). `lines[i].product_id` must already be resolved for
   * variant-only lines.
   */
  async planLines(
    storeId: string,
    lines: DesignerLineInput[],
    opts: {
      mode: DesignerLineMode;
      customerId?: string | null;
      refs?: DesignLineRef[];
      /**
       * Designs a stored checkout session verified (Kustom). Required in
       * `snapshot` mode (absent = none trusted); in `quote` mode it marks
       * an order-bound quote that must not price unverified designs.
       */
      verifiedDesignIds?: readonly string[] | null;
    },
  ): Promise<(DesignerLine | null)[]> {
    const refOf = (i: number) => opts.refs?.[i] ?? { line_index: i };
    const hasDesign = lines.some((l) => !!l.design_id);
    const enabled = await this.storeApps.isEnabled(storeId, 'designer');
    if (!enabled) {
      const i = lines.findIndex((l) => !!l.design_id);
      if (hasDesign) {
        throw this.err(
          'badRequest',
          'DESIGNER_NOT_ENABLED',
          'Designed products cannot be ordered from this store right now.',
          refOf(i),
        );
      }
      return lines.map(() => null);
    }
    const productIds = [
      ...new Set(
        lines
          .filter((l) => !l.custom_product_id && l.product_id)
          .map((l) => l.product_id as string),
      ),
    ];
    const links = productIds.length
      ? await this.prisma.productDesigner.findMany({
          where: {
            product_id: { in: productIds },
            store_id: storeId,
            enabled: true,
          },
          select: {
            product_id: true,
            template_id: true,
            enabled: true,
            addons: true,
            template: LINK_TEMPLATE_SELECT,
          },
        })
      : [];
    const linkOf = new Map(
      links.map((l) => [l.product_id, activeLinkTemplateId(l)]),
    );
    const addonsOf = new Map(links.map((l) => [l.product_id, l.addons]));
    const verified =
      opts.verifiedDesignIds !== undefined && opts.verifiedDesignIds !== null
        ? new Set(opts.verifiedDesignIds)
        : opts.mode === 'snapshot'
          ? new Set<string>()
          : null;
    const out: (DesignerLine | null)[] = [];
    for (const [i, line] of lines.entries()) {
      const productId = line.custom_product_id
        ? null
        : (line.product_id ?? null);
      const templateId = productId ? (linkOf.get(productId) ?? null) : null;
      if (!line.design_id) {
        if (templateId) {
          throw this.err(
            'badRequest',
            'DESIGNER_DESIGN_REQUIRED',
            'Design this product before adding it to the cart.',
            refOf(i),
          );
        }
        out.push(null);
        continue;
      }
      const design = await this.loadDesign(line.design_id, storeId, refOf(i));
      out.push(
        await this.assertDesign(design, line, productId, templateId, {
          mode: opts.mode,
          customerId: opts.customerId ?? null,
          ref: refOf(i),
          verified,
          linkAddons: productId ? addonsOf.get(productId) : null,
        }),
      );
    }
    // §9 R1: a design that is being priced is in use (throttled refresh).
    if (opts.mode === 'quote') {
      await this.touchDesigns(
        out.filter((l): l is DesignerLine => !!l).map((l) => l.design),
      );
    }
    return out;
  }

  /**
   * Refreshes `updated_at` of unordered designs not touched for a day, so
   * the draft purge (R1, `updated_at + draft_retention_days`) never removes
   * a design a cart or a checkout still reads. Best-effort, never throws.
   */
  async touchDesigns(
    designs: Pick<Design, 'id' | 'status' | 'updated_at'>[],
    now: Date = new Date(),
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - DESIGN_TOUCH_INTERVAL_MS);
    const ids = [
      ...new Set(
        designs
          .filter(
            (d) =>
              d.status !== DesignStatus.ORDERED &&
              d.updated_at instanceof Date &&
              d.updated_at.getTime() < cutoff.getTime(),
          )
          .map((d) => d.id),
      ),
    ];
    if (!ids.length) return;
    try {
      await this.prisma.design.updateMany({
        where: {
          id: { in: ids },
          status: { not: DesignStatus.ORDERED },
          updated_at: { lt: cutoff },
        },
        data: { updated_at: now },
      });
    } catch (e) {
      this.logger.debug(
        `design touch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Kustom session create / update (ownership is checked on the raw lines,
   * BEFORE they are normalized and the token dropped): every designer line
   * must be the caller's — a guest presents the design token; a logged-in
   * customer owns the design or presents its token (the design is then
   * claimed for them, as a server-cart add would). Lines whose design the
   * session already verified (`alreadyVerified`) pass without a token.
   * ORDERED designs are locked. Returns the verified design ids, which the
   * session stores with its lines. No query when no line carries a design.
   */
  async verifySessionDesigns(
    storeId: string,
    lines: DesignerLineInput[],
    customerId: string | null,
    alreadyVerified: readonly string[] = [],
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const withDesign = lines
      .map((line, index) => ({ line, index }))
      .filter((x) => !!x.line.design_id);
    if (!withDesign.length) return out;
    if (!(await this.storeApps.isEnabled(storeId, 'designer'))) {
      throw this.err(
        'badRequest',
        'DESIGNER_NOT_ENABLED',
        'Designed products cannot be ordered from this store right now.',
        { line_index: withDesign[0].index },
      );
    }
    const previous = new Set(alreadyVerified);
    for (const { line, index } of withDesign) {
      const ref = { line_index: index };
      const design = await this.loadDesign(
        line.design_id as string,
        storeId,
        ref,
      );
      if (design.status === DesignStatus.ORDERED) {
        throw this.err(
          'conflict',
          'DESIGNER_DESIGN_LOCKED',
          'This design has already been ordered. Please create a new design.',
          ref,
        );
      }
      // The guest token counts only while the design has no owner (a
      // claimed design answers to its customer only, designer-access.ts).
      const tokenOk =
        !design.customer_id &&
        designTokenMatches(design.access_token_hash, line.design_token ?? null);
      const owned = !!customerId && design.customer_id === customerId;
      const keptVerified = !design.customer_id && previous.has(design.id);
      if (!owned && !tokenOk && !keptVerified) {
        throw this.err(
          'forbidden',
          'DESIGNER_DESIGN_FORBIDDEN',
          'This design belongs to someone else.',
          ref,
        );
      }
      if (customerId && tokenOk) {
        await this.prisma.design.updateMany({
          where: {
            id: design.id,
            customer_id: null,
            status: { not: DesignStatus.ORDERED },
          },
          data: { customer_id: customerId, status: DesignStatus.IN_CART },
        });
      }
      out.add(design.id);
    }
    return out;
  }

  /**
   * Server-cart add (`cart.addItem`, guest migration): the validated line
   * (claimed for the customer) or null for an ordinary line.
   */
  async resolveCartLine(
    line: DesignerLineInput,
    productId: string | null,
    customerId: string | null,
  ): Promise<DesignerLine | null> {
    if (!line.design_id) {
      if (!productId || line.custom_product_id) return null;
      const link = await this.prisma.productDesigner.findUnique({
        where: { product_id: productId },
        select: {
          enabled: true,
          store_id: true,
          template_id: true,
          template: LINK_TEMPLATE_SELECT,
        },
      });
      if (!link || !activeLinkTemplateId(link)) return null;
      if (!(await this.storeApps.isEnabled(link.store_id, 'designer'))) {
        return null;
      }
      throw this.err(
        'badRequest',
        'DESIGNER_DESIGN_REQUIRED',
        'Design this product before adding it to the cart.',
      );
    }
    const design = await this.loadDesign(line.design_id, null);
    if (!(await this.storeApps.isEnabled(design.store_id, 'designer'))) {
      throw this.err(
        'badRequest',
        'DESIGNER_NOT_ENABLED',
        'Designed products cannot be added in this store right now.',
      );
    }
    const link =
      productId && !line.custom_product_id
        ? await this.prisma.productDesigner.findUnique({
            where: { product_id: productId },
            select: {
              enabled: true,
              store_id: true,
              template_id: true,
              addons: true,
              template: LINK_TEMPLATE_SELECT,
            },
          })
        : null;
    const templateId =
      link && link.store_id === design.store_id
        ? activeLinkTemplateId(link)
        : null;
    const validated = await this.assertDesign(
      design,
      line,
      line.custom_product_id ? null : productId,
      templateId,
      {
        mode: 'cart',
        customerId,
        linkAddons: templateId ? link?.addons : null,
      },
    );
    // Claim: the design now belongs to the customer and is in a cart.
    if (
      customerId &&
      (design.customer_id !== customerId ||
        design.status === DesignStatus.DRAFT)
    ) {
      // Only an unowned design (or the customer's own) is (re)claimed.
      await this.prisma.design.updateMany({
        where: {
          id: design.id,
          customer_id: design.customer_id ? customerId : null,
          status: { not: DesignStatus.ORDERED },
        },
        data: { customer_id: customerId, status: DesignStatus.IN_CART },
      });
      validated.design = {
        ...validated.design,
        customer_id: customerId,
        status: DesignStatus.IN_CART,
      };
    }
    return validated;
  }

  private async loadDesign(
    id: string,
    storeId: string | null,
    ref: DesignLineRef = {},
  ): Promise<LoadedDesign> {
    const design = isUuid(id)
      ? await this.prisma.design.findUnique({
          where: { id },
          include: {
            template_version: {
              select: {
                id: true,
                template_id: true,
                version: true,
                spec: true,
              },
            },
          },
        })
      : null;
    if (!design || (storeId && design.store_id !== storeId)) {
      throw this.err(
        'notFound',
        'DESIGNER_DESIGN_NOT_FOUND',
        'The design of this item no longer exists. Please design it again.',
        ref,
      );
    }
    return design;
  }

  private async assertDesign(
    design: LoadedDesign,
    line: DesignerLineInput,
    productId: string | null,
    linkTemplateId: string | null,
    opts: {
      mode: DesignerLineMode;
      customerId: string | null;
      ref?: DesignLineRef;
      /** Session-verified designs (snapshot; order-bound quote). */
      verified?: Set<string> | null;
      /** M5.5: the product link's `addons` (current config). */
      linkAddons?: unknown;
    },
  ): Promise<DesignerLine> {
    const ref = opts.ref ?? {};
    // Rule 3: store (checked by the loader), product, template.
    if (
      !productId ||
      design.product_id !== productId ||
      !linkTemplateId ||
      design.template_version.template_id !== linkTemplateId
    ) {
      throw this.err(
        'badRequest',
        'DESIGNER_TEMPLATE_MISMATCH',
        'This design does not belong to this product.',
        ref,
      );
    }
    // Owner.
    const token = line.design_token ?? null;
    // The token counts only while the design has no owner.
    const tokenOk =
      !design.customer_id &&
      designTokenMatches(design.access_token_hash, token);
    const forbidden = () =>
      this.err(
        'forbidden',
        'DESIGNER_DESIGN_FORBIDDEN',
        'This design belongs to someone else.',
        ref,
      );
    const ownedByCustomer =
      !!opts.customerId && design.customer_id === opts.customerId;
    if (opts.mode === 'snapshot') {
      if (!opts.verified?.has(design.id)) throw forbidden();
    } else if (opts.mode === 'quote') {
      if (token && !design.customer_id && !tokenOk) throw forbidden();
      if (opts.verified && !opts.verified.has(design.id) && !ownedByCustomer) {
        throw forbidden();
      }
    } else if (design.customer_id) {
      if (!ownedByCustomer) throw forbidden();
    } else if (!tokenOk || (opts.mode === 'cart' && !opts.customerId)) {
      throw forbidden();
    }
    if (design.status === DesignStatus.ORDERED) {
      throw this.err(
        'conflict',
        'DESIGNER_DESIGN_LOCKED',
        'This design has already been ordered. Please create a new design.',
        ref,
      );
    }
    // Rule 4.
    const spec = design.template_version.spec as unknown as TemplateSpecV1;
    const { state, photos } = await this.designs.validateDesignState(
      design.store_id,
      design.id,
      spec,
      design.state,
      { requireComplete: true, ref },
    );
    const { template_version: version, ...row } = design;
    return {
      design: row,
      version,
      spec,
      state,
      photos,
      ...this.lineDelta(opts.linkAddons, row.addons),
    };
  }

  /**
   * Designer price delta per unit (M5.5): the design's selection priced
   * against the link's current add-ons (base currency). 0 and no lines
   * when the product has no enabled add-on or nothing is selected.
   */
  lineDelta(
    linkAddons?: unknown,
    selection?: unknown,
  ): { priceDelta: number; addons: PricedAddon[] } {
    if (selection == null || linkAddons == null) {
      return { priceDelta: 0, addons: [] };
    }
    const { lines, total } = priceAddons(linkAddons, selection);
    return { priceDelta: total, addons: lines };
  }

  // ── Order snapshot ────────────────────────────────────────────────────────

  /**
   * The frozen design of an order line (D11) and its text value rows (C19).
   * `create` goes into `items.create[].design.create`, so it is inserted in
   * the same `order.create` as the order (atomic).
   */
  async snapshot(
    line: DesignerLine,
    o: {
      orderId: string;
      storeId: string;
      locale?: string | null;
      primaryLocale?: string | null;
      /** M5.5: the line's add-ons in the order currency (priceLine). */
      addons?: PricedAddon[];
      addonsTotal?: number;
      currency?: string | null;
    },
  ): Promise<{
    create: Prisma.OrderItemDesignUncheckedCreateWithoutOrder_itemInput;
    designTexts: DesignTextInput[];
    textValues: DesignTextValue[];
  }> {
    const locale = o.locale?.trim().toLowerCase() || o.primaryLocale || null;
    const settings = normalizeDesignerSettings(
      await this.storeApps.getSettings(o.storeId, 'designer'),
    );
    const slots = slotMap(line.spec);
    const assets: Record<string, unknown>[] = [];
    for (const [slotId, p] of Object.entries(line.state.photos)) {
      const a = line.photos.get(slotId);
      const slot = slots.get(slotId);
      const dpi = slot ? effectiveDpi(slot, p.width, p.height, p.adj) : 0;
      assets.push({
        asset_id: p.asset_id,
        role: 'photo',
        element_id: slotId,
        width: p.width,
        height: p.height,
        sha256: a?.sha256 ?? null,
        effective_dpi: Math.round(dpi * 10) / 10,
        low_res: dpi > 0 && dpi < settings.min_effective_dpi_warning,
      });
    }
    const uses = specAssetUses(line.spec);
    const rows = await this.assets.findOwnedAssets(
      o.storeId,
      uses.map((u) => u.asset_id),
    );
    for (const u of uses) {
      const a = rows.get(u.asset_id);
      assets.push({
        asset_id: u.asset_id,
        role: u.role,
        ...(u.element_id ? { element_id: u.element_id } : {}),
        width: a?.width ?? null,
        height: a?.height ?? null,
        sha256: a?.sha256 ?? null,
      });
    }
    const textValues = designTextValues(line.spec, line.state, locale);
    // §5.4: the draft's proof is reused when it was rendered from exactly
    // this state; otherwise the worker renders the order proof.
    const proofKey =
      line.design.proof_key &&
      line.design.proof_state_sha ===
        designProofSha(line.design.state, line.version.id)
        ? line.design.proof_key
        : null;
    return {
      create: {
        order_id: o.orderId,
        store_id: o.storeId,
        design_id: line.design.id,
        template_id: line.version.template_id,
        template_version_id: line.version.id,
        template_spec: line.spec as unknown as Prisma.InputJsonValue,
        state: line.state as unknown as Prisma.InputJsonValue,
        assets: assets as unknown as Prisma.InputJsonValue,
        text_values: textValues.map((t) => ({
          element_id: t.element_id,
          label: t.label,
          value: t.value,
        })) as unknown as Prisma.InputJsonValue,
        // M5.5: per-unit add-ons in the ORDER currency (`o.addons`, the
        // converted lines priceLine used), else the base-currency lines.
        price_breakdown: {
          designer_delta: o.addonsTotal ?? line.priceDelta,
          addons: (o.addons ?? line.addons).map((a) => ({
            key: a.key,
            type: a.type,
            label: a.label,
            qty: a.qty,
            unit_price: a.unit_price,
            amount: a.amount,
          })),
          ...(o.currency ? { currency: o.currency } : {}),
        } as Prisma.InputJsonValue,
        renderer_version: RENDERER_VERSION,
        proof_key: proofKey,
        print_status: 'PENDING',
        print_requested_at: null,
      },
      // M5.5: each chosen add-on becomes one more DESIGN row ("Dubbelsidig:
      // +149 kr"), so emails, invoices and order views show it as a line
      // detail. Lines without add-ons get exactly the text rows.
      designTexts: [
        ...textValues.map((t) => ({
          element_id: t.element_id,
          label: t.labels,
          value: t.value,
        })),
        ...(o.addons?.length && o.currency
          ? o.addons.map((a) => ({
              element_id: `addon:${a.key}`,
              label: { ...a.label },
              value: addonDetailText(a, o.currency as string, locale),
            }))
          : []),
      ],
      textValues,
    };
  }

  /**
   * Inside the order transaction: the ordered designs are frozen (no more
   * edits, never purged as drafts; photo retention now runs on the order
   * clock, §9 R3). Each design is frozen at the `state_version` the order
   * validated and snapshotted: a design edited, or ordered by a concurrent
   * checkout, since then throws 409 DESIGNER_DESIGN_STALE / LOCKED, which
   * rolls the whole order back.
   */
  async markOrdered(
    tx: Prisma.TransactionClient,
    designs: { id: string; state_version: number }[],
  ): Promise<void> {
    const byId = new Map<string, number>();
    for (const d of designs) {
      if (isUuid(d.id)) byId.set(d.id, d.state_version);
    }
    for (const [id, version] of byId) {
      const res = await tx.design.updateMany({
        where: {
          id,
          state_version: version,
          status: { not: DesignStatus.ORDERED },
        },
        data: { status: DesignStatus.ORDERED },
      });
      if (res.count === 1) continue;
      const current = await tx.design.findUnique({
        where: { id },
        select: { status: true },
      });
      throw current?.status === DesignStatus.ORDERED
        ? this.err(
            'conflict',
            'DESIGNER_DESIGN_LOCKED',
            'This design has already been ordered. Please create a new design.',
          )
        : this.err(
            'conflict',
            'DESIGNER_DESIGN_STALE',
            'The design was changed during checkout. Please review it and try again.',
          );
    }
  }

  // ── Read paths ────────────────────────────────────────────────────────────

  /**
   * The `design` block of designer cart rows (GET /cart), keyed by design
   * id. A design checkout would refuse is flagged `invalid` with the code
   * checkout would answer (app off, ordered, template archived / relinked,
   * incomplete state, purged photo), so the cart can offer "edit" or
   * "remove" before checkout. Reading the cart keeps the drafts alive
   * (throttled `updated_at` refresh, §9 R1). A missing design (purged
   * draft) has no entry.
   */
  async cartDesigns(
    designIds: string[],
    locale?: string | null,
  ): Promise<Map<string, CartDesignView>> {
    const ids = [...new Set(designIds.filter(isUuid))];
    const out = new Map<string, CartDesignView>();
    if (!ids.length) return out;
    const rows = await this.prisma.design.findMany({
      where: { id: { in: ids } },
      include: {
        template_version: {
          select: { id: true, template_id: true, version: true, spec: true },
        },
      },
    });
    if (!rows.length) return out;
    const productIds = [...new Set(rows.map((d) => d.product_id))];
    const photoIds = rows.flatMap((d) =>
      Object.values(
        ((d.state ?? {}) as Partial<DesignStateV1>).photos ?? {},
      ).map((p) => p?.asset_id),
    );
    const [links, slugs, photos] = await Promise.all([
      this.prisma.productDesigner.findMany({
        where: { product_id: { in: productIds } },
        select: {
          product_id: true,
          store_id: true,
          enabled: true,
          template_id: true,
          addons: true,
          template: LINK_TEMPLATE_SELECT,
        },
      }),
      this.productSlugs(productIds, locale),
      photoIds.filter(isUuid).length
        ? this.prisma.designAsset.findMany({
            where: { id: { in: [...new Set(photoIds.filter(isUuid))] } },
            select: { id: true, design_id: true, purged_at: true },
          })
        : Promise.resolve(
            [] as {
              id: string;
              design_id: string | null;
              purged_at: Date | null;
            }[],
          ),
    ]);
    const linkOf = new Map(links.map((l) => [l.product_id, l]));
    const photoOf = new Map(photos.map((p) => [p.id, p]));
    const enabledOf = new Map<string, boolean>();
    for (const storeId of new Set(rows.map((d) => d.store_id))) {
      enabledOf.set(
        storeId,
        await this.storeApps.isEnabled(storeId, 'designer'),
      );
    }
    for (const d of rows) {
      const spec = d.template_version.spec as unknown as TemplateSpecV1;
      const state = (d.state ?? {
        v: 1,
        texts: {},
        photos: {},
      }) as unknown as DesignStateV1;
      const link = linkOf.get(d.product_id);
      const activeTemplate =
        link && link.store_id === d.store_id
          ? activeLinkTemplateId(link)
          : null;
      let invalid: DesignerErrorCode | null = null;
      if (!enabledOf.get(d.store_id)) invalid = 'DESIGNER_NOT_ENABLED';
      else if (d.status === DesignStatus.ORDERED) {
        invalid = 'DESIGNER_DESIGN_LOCKED';
      } else if (
        !activeTemplate ||
        activeTemplate !== d.template_version.template_id
      ) {
        invalid = 'DESIGNER_TEMPLATE_MISMATCH';
      } else if (
        !validateState(spec, state, { requireComplete: true }).ok ||
        Object.values(state.photos ?? {}).some((p) => {
          const a = photoOf.get(p?.asset_id);
          return !a || a.purged_at || a.design_id !== d.id;
        })
      ) {
        invalid = 'DESIGNER_STATE_INVALID';
      }
      const priced =
        activeTemplate && d.addons != null
          ? priceAddons(link?.addons, d.addons).lines
          : [];
      out.set(d.id, {
        id: d.id,
        text_values: designTextValues(spec, state, locale).map((t) => ({
          element_id: t.element_id,
          label: t.label,
          value: t.value,
        })),
        editable: d.status !== DesignStatus.ORDERED,
        proof_url: this.designProofUrl(d),
        product_slug: slugs.get(d.product_id) ?? null,
        ...(priced.length
          ? {
              addons: priced.map((a) => ({
                key: a.key,
                type: a.type,
                label: addonLabel(a.label, locale),
                qty: a.qty,
                unit_price: a.unit_price,
                amount: a.amount,
              })),
            }
          : {}),
        ...(invalid ? { invalid: true as const, invalid_code: invalid } : {}),
      });
    }
    await this.touchDesigns(rows);
    return out;
  }

  /**
   * Product slug per product id in `locale` (else the same language,
   * else any translation). One query for all products.
   */
  async productSlugs(
    productIds: string[],
    locale?: string | null,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(productIds.filter(isUuid))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.prisma.productTranslation.findMany({
      where: { product_id: { in: ids } },
      select: { product_id: true, locale: true, slug: true },
    });
    const want = (locale ?? '').trim().toLowerCase();
    const lang = want.split(/[-_]/)[0];
    for (const id of ids) {
      const mine = rows.filter((r) => r.product_id === id && r.slug);
      const pick =
        mine.find((r) => r.locale.toLowerCase() === want) ??
        mine.find((r) => r.locale.toLowerCase().split(/[-_]/)[0] === lang) ??
        mine[0];
      if (pick) out.set(id, pick.slug);
    }
    return out;
  }

  /**
   * `GET designer/my/orders/:orderId/designs` (§4.3, creator dashboard):
   * the frozen designs of the order's lines with proof / photo links,
   * text values, print status and purge dates. 404 for another store's
   * order. Links are relative signed paths (1 h).
   */
  async orderDesigns(storeId: string, orderId: string) {
    const order = isUuid(orderId)
      ? await this.prisma.order.findFirst({
          where: { id: orderId, store_id: storeId },
          select: {
            id: true,
            order_number: true,
            created_at: true,
            status: true,
          },
        })
      : null;
    if (!order) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'Order not found.',
      );
    }
    const rows = await this.prisma.orderItemDesign.findMany({
      where: { order_id: order.id, store_id: storeId },
      orderBy: { created_at: 'asc' },
      include: {
        order_item: {
          select: {
            id: true,
            product_id: true,
            variant_id: true,
            quantity: true,
          },
        },
      },
    });
    // Readable while the app is off (order history): the last saved
    // settings, as retention uses them.
    const settings = normalizeDesignerSettings(
      (await this.storeApps.getSettings(storeId, 'designer')) ??
        (
          await this.prisma.storeApp.findUnique({
            where: {
              store_id_app_key: { store_id: storeId, app_key: 'designer' },
            },
            select: { settings: true },
          })
        )?.settings ??
        null,
    );
    const photoIds: string[] = [];
    for (const r of rows) {
      for (const a of asList(r.assets)) {
        if (a.role === 'photo' && typeof a.asset_id === 'string') {
          photoIds.push(a.asset_id);
        }
      }
    }
    const photos = photoIds.length
      ? await this.prisma.designAsset.findMany({
          where: { id: { in: [...new Set(photoIds)] }, store_id: storeId },
        })
      : [];
    const photoById = new Map(photos.map((p) => [p.id, p]));
    const day = 24 * 60 * 60 * 1000;
    const plus = (d: Date | null, days: number) =>
      d ? new Date(d.getTime() + days * day) : null;
    return {
      order_id: order.id,
      order_number: order.order_number,
      items: rows.map((r) => {
        const assets = asList(r.assets).map((a) => {
          if (a.role !== 'photo') return a;
          const row = photoById.get(String(a.asset_id));
          const view =
            row && !row.purged_at ? this.assets.assetView(row) : null;
          return {
            ...a,
            preview_url: view?.preview_url ?? null,
            original_available:
              !!row && !row.purged_at && !r.originals_purged_at,
          };
        });
        const filesPurgeAt = [
          plus(r.shipped_at, settings.print_keep_days_after_shipped),
          plus(r.terminal_at, 14),
          plus(r.created_at, 365),
        ]
          .filter((d): d is Date => !!d)
          .sort((a, b) => a.getTime() - b.getTime())[0];
        return {
          order_item_id: r.order_item_id,
          order_item_design_id: r.id,
          design_id: r.design_id,
          product_id: r.order_item.product_id,
          variant_id: r.order_item.variant_id,
          quantity: r.order_item.quantity,
          template_id: r.template_id,
          template_version_id: r.template_version_id,
          renderer_version: r.renderer_version,
          proof_url: this.render
            ? this.render.orderProofPath(r)
            : !r.proof_key || r.files_purged_at
              ? null
              : this.urls.signedPath('oid_proof', r.id, r.store_id, {
                  ttlSec: DESIGNER_LINK_TTL.creator,
                }),
          text_values: r.text_values,
          /** M5.5: the add-ons sold with the line (order currency, per unit). */
          addons: orderAddonsOf(r.price_breakdown),
          addons_currency: orderAddonsCurrencyOf(r.price_breakdown),
          /** Frozen state (texts + photo refs) and template, for the dashboard preview. */
          state: r.state,
          template_spec: r.template_spec,
          assets,
          low_res: assets.some((a) => a.low_res === true),
          print: {
            status: r.print_status,
            attempts: r.print_attempts,
            error: r.print_error,
            requested_at: r.print_requested_at,
            rendered_at: r.print_rendered_at,
            files: asList(r.print_files).map((f) => ({
              surface: f.surface,
              format: f.format,
              width_px: f.width_px,
              height_px: f.height_px,
              dpi: f.dpi,
              bytes: f.bytes,
              ...printFileExtras(f as unknown as PrintFile),
            })),
            download_path:
              r.print_status === 'READY' && !r.files_purged_at
                ? `/api/designer/my/orders/${order.id}/items/${r.order_item_id}/print`
                : null,
            pdf_download_path:
              r.print_status === 'READY' &&
              !r.files_purged_at &&
              asList(r.print_files).some((f) => f.format === 'pdf')
                ? `/api/designer/my/orders/${order.id}/items/${r.order_item_id}/print?format=pdf`
                : null,
          },
          shipped_at: r.shipped_at,
          terminal_at: r.terminal_at,
          originals_purged_at: r.originals_purged_at,
          files_purged_at: r.files_purged_at,
          // Same rule as retention R3: READY print or terminal order →
          // retention_days; otherwise the 7-day print grace is added.
          originals_purge_at: r.originals_purged_at
            ? null
            : originalsPurgeAt(order.created_at, settings.retention_days, {
                print_status: r.print_status,
                terminal_at: r.terminal_at,
                order_status: order.status,
              }),
          files_purge_at: r.files_purged_at ? null : (filesPurgeAt ?? null),
        };
      }),
    };
  }

  /**
   * `GET designer/my/orders/:orderId/items/:itemId/originals/:assetId`: the
   * customer's original photo of an ordered line, as an attachment. The
   * asset must be one of that line's snapshot photos (404 otherwise); 410
   * DESIGNER_FILES_PURGED once retention / erasure removed the originals.
   * Readable while the app is off (order history).
   */
  async orderOriginal(
    storeId: string,
    orderId: string,
    itemId: string,
    assetId: string,
  ): Promise<{ buffer: Buffer; mime: string; filename: string }> {
    const row =
      isUuid(orderId) && isUuid(itemId)
        ? await this.prisma.orderItemDesign.findFirst({
            where: {
              store_id: storeId,
              order_id: orderId,
              order_item_id: itemId,
            },
            select: {
              id: true,
              assets: true,
              originals_purged_at: true,
              files_purged_at: true,
              order_item: {
                select: { order: { select: { order_number: true } } },
              },
            },
          })
        : null;
    if (!row) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'This order item has no design.',
      );
    }
    const photo = asList(row.assets).find(
      (a) => a.role === 'photo' && a.asset_id === assetId,
    );
    if (!photo || !isUuid(assetId)) {
      throw designerErrors.notFound(
        'DESIGNER_ASSET_NOT_FOUND',
        'This photo does not belong to the order item.',
      );
    }
    const gone = () =>
      designerErrors.gone(
        'DESIGNER_FILES_PURGED',
        'The original photo has been deleted.',
      );
    if (row.originals_purged_at || row.files_purged_at) throw gone();
    const asset = await this.prisma.designAsset.findFirst({
      where: {
        id: assetId,
        store_id: storeId,
        kind: DesignAssetKind.CUSTOMER_PHOTO,
      },
    });
    if (!asset || asset.purged_at) throw gone();
    const buffer = await this.assets.readAssetBytes(asset, 'original');
    const ext = asset.mime === 'image/png' ? 'png' : 'jpg';
    const orderNumber = (
      row.order_item?.order?.order_number ?? orderId.slice(0, 8)
    ).replace(/[^A-Za-z0-9_-]/g, '');
    const slot = (
      typeof photo.element_id === 'string' ? photo.element_id : 'photo'
    ).replace(/[^A-Za-z0-9_-]/g, '');
    return {
      buffer,
      mime: asset.mime,
      filename: `${orderNumber}-${slot}-original.${ext}`,
    };
  }

  /** Signed absolute proof URL of a draft, when its proof matches the state. */
  designProofUrl(
    d: Pick<Design, 'id' | 'store_id' | 'proof_key' | 'proof_state_sha'>,
  ): string | null {
    if (!d.proof_key || !d.proof_state_sha) return null;
    return this.urls.absolute(
      this.urls.signedPath('proof', d.id, d.store_id, {
        ttlSec: DESIGNER_LINK_TTL.editor,
      }),
    );
  }

  /**
   * Signed absolute proof URL of an ordered line (account, dashboard),
   * null once the files are purged or before the proof exists. Sync.
   */
  orderItemProofUrl(
    d:
      | {
          id: string;
          store_id: string;
          proof_key: string | null;
          files_purged_at: Date | null;
        }
      | null
      | undefined,
  ): string | null {
    if (!d || !d.proof_key || d.files_purged_at) return null;
    return this.urls.absolute(
      this.urls.signedPath('oid_proof', d.id, d.store_id, {
        ttlSec: 24 * 60 * 60,
      }),
    );
  }
}

function asList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (x): x is Record<string, unknown> => !!x && typeof x === 'object',
      )
    : [];
}
