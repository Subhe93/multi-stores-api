import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportEntityStatus,
  MenuItemKind,
  Prisma,
  RedirectSource,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { hashOf } from '../importer/mapping/hash';
import { upsertLedger } from '../importer/apply/apply-context';
import {
  buildPublishSnapshot,
  publishPageTx,
} from '../pages-v2/pages-v2.service';
import { RedirectsService } from '../redirects/redirects.service';
import type { ExistingRedirectRow } from '../redirects/redirect-plan';
import {
  OCCASION_ENTITY_TYPE,
  planOccasionConversion,
  type ConversionInput,
  type ConversionPlan,
  type ConversionState,
  type PlannedConversionItem,
  type StateProduct,
} from './occasion-conversion.planner';

/** Before-image stored in the ledger payload of a converted category. */
interface ItemBefore {
  conversion_id: string;
  page_id: string;
  version_id: string;
  category: { parent_id: string | null; visibility: 'PUBLIC' | 'INTERNAL' };
  links_added: PlannedConversionItem['links_added'];
  primaries: PlannedConversionItem['primaries'];
  menu_items: {
    id: string;
    kind: string;
    resource_id: string | null;
    url: string;
  }[];
}

/** Before-image of the redirect writes of one batch (ledger row `batch:<id>`). */
interface BatchBefore {
  conversion_id: string;
  created: string[];
  updated: {
    id: string;
    to_path: string;
    status_code: number;
    source: 'IMPORT' | 'MANUAL';
    is_active: boolean;
  }[];
}

export interface ConversionReport {
  conversion_id: string | null;
  store: string;
  plan: ConversionPlan;
}

export interface RollbackReport {
  conversion_id: string;
  restored: number;
  kept: { slug: string; reason: string }[];
  redirects: { deleted: number; restored: number };
}

const TX_TIMEOUT_MS = 120_000;
const BATCH_REF = (id: string) => `batch:${id}`;

@Injectable()
export class OccasionConversionService {
  private readonly logger = new Logger(OccasionConversionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
    private readonly redirects: RedirectsService,
  ) {}

  async dryRun(
    storeId: string,
    input: ConversionInput,
  ): Promise<ConversionReport> {
    const state = await this.loadState(storeId);
    const plan = planOccasionConversion(state, input);
    return { conversion_id: null, store: storeId, plan };
  }

  /**
   * Executes exactly the dry-run plan (same state → same fingerprint). One
   * transaction for the whole batch: pages, labels, links, primaries, menu
   * items, ledger rows and redirects, so a failure leaves nothing half done.
   */
  async apply(
    storeId: string,
    input: ConversionInput,
    fingerprint: string,
  ): Promise<ConversionReport> {
    const state = await this.loadState(storeId);
    const plan = planOccasionConversion(state, input);
    if (plan.fingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'OCCASION_PLAN_STALE',
        message: 'The store changed since the dry run; run it again',
      });
    }
    if (plan.blockers.length) {
      throw new BadRequestException({
        code: 'OCCASION_PLAN_BLOCKED',
        message: plan.blockers.join(','),
      });
    }
    const conversionId = randomUUID();
    const ctx = { storeId, runId: conversionId };

    await this.prisma.$transaction(
      async (tx) => {
        for (const item of plan.items) {
          if (item.action !== 'CREATE' || !item.page) continue;
          const page = item.page;

          // 1. The page, its sections and the published version.
          const created = await tx.page.create({
            data: {
              store_id: storeId,
              type: 'LANDING',
              slug: page.slug,
              seo: {},
              translations: {
                create: {
                  locale: state.primaryLocale,
                  title: page.title,
                  meta_title: page.meta_title,
                  meta_description: page.meta_description,
                },
              },
              sections: {
                create: page.sections.map((s, i) => ({
                  section_key: s.section_key,
                  settings: s.settings as Prisma.InputJsonValue,
                  sort_order: i,
                  translations: {
                    create: {
                      locale: state.primaryLocale,
                      content: s.content as Prisma.InputJsonValue,
                    },
                  },
                })),
              },
            },
            include: {
              translations: true,
              sections: { include: { translations: true } },
            },
          });
          const version = await publishPageTx(
            tx,
            created.id,
            buildPublishSnapshot(created),
            'occasion-conversion',
          );

          // 2. The collection becomes the page's INTERNAL label. Children
          //    were converted first (deepest-first order), so none remain.
          const children = await tx.creatorCategory.count({
            where: { parent_id: item.category_id },
          });
          if (children > 0) {
            throw new ConflictException({
              code: 'CREATOR_CATEGORY_INTERNAL_HAS_CHILDREN',
              message: `${item.slug} still has sub-collections`,
            });
          }
          const cat = await tx.creatorCategory.findUniqueOrThrow({
            where: { id: item.category_id },
            select: { parent_id: true, visibility: true },
          });
          await tx.creatorCategory.update({
            where: { id: item.category_id },
            data: { visibility: 'INTERNAL', parent_id: null },
          });

          // 3. Descendant products merged into the label.
          const productLinks = item.links_added.filter(
            (l) => l.entity === 'PRODUCT',
          );
          const customLinks = item.links_added.filter(
            (l) => l.entity === 'CUSTOM_PRODUCT',
          );
          if (productLinks.length)
            await tx.productCreatorCategory.createMany({
              data: productLinks.map((l, i) => ({
                product_id: l.id,
                creator_category_id: item.category_id,
                sort_order: 1000 + i,
              })),
              skipDuplicates: true,
            });
          if (customLinks.length)
            await tx.customProductCreatorCategory.createMany({
              data: customLinks.map((l, i) => ({
                custom_product_id: l.id,
                creator_category_id: item.category_id,
                sort_order: 1000 + i,
              })),
              skipDuplicates: true,
            });

          // 4. Primaries re-picked (an INTERNAL label is never primary).
          for (const p of item.primaries) {
            if (p.entity === 'PRODUCT')
              await tx.product.update({
                where: { id: p.id },
                data: { primary_creator_category_id: p.to },
              });
            else
              await tx.customProduct.update({
                where: { id: p.id },
                data: { primary_creator_category_id: p.to },
              });
          }

          // 5. Menu items: COLLECTION → PAGE (the storefront drops INTERNAL
          //    collection items together with their children).
          const menuBefore: ItemBefore['menu_items'] = [];
          for (const m of item.menu_items) {
            const row = await tx.menuItem.findUniqueOrThrow({
              where: { id: m.id },
              select: { id: true, kind: true, resource_id: true, url: true },
            });
            menuBefore.push(row);
            await tx.menuItem.update({
              where: { id: m.id },
              data: {
                kind: MenuItemKind.PAGE,
                resource_id: created.id,
                url: m.url,
              },
            });
          }

          // 6. Ledger row with the before-image.
          const before: ItemBefore = {
            conversion_id: conversionId,
            page_id: created.id,
            version_id: version.id,
            category: cat,
            links_added: item.links_added,
            primaries: item.primaries,
            menu_items: menuBefore,
          };
          await upsertLedger(tx, ctx, {
            entity_type: OCCASION_ENTITY_TYPE,
            external_ref: item.external_ref,
            target_id: created.id,
            source_hash: item.source_hash,
            applied_hash: hashOf(page),
            created: true,
            status: ImportEntityStatus.ACTIVE,
            payload: before as unknown as Prisma.InputJsonValue,
          });
        }

        // 7. Redirects: new rows are MANUAL (an import never overwrites,
        //    deactivates or re-points them); existing rows whose target
        //    became a source are flattened to the page in one hop.
        const batch: BatchBefore = {
          conversion_id: conversionId,
          created: [],
          updated: [],
        };
        for (const r of plan.redirects.items) {
          if (r.action === 'UNCHANGED') continue;
          if (r.action === 'CREATE') {
            const row = await tx.storeRedirect.create({
              data: {
                store_id: storeId,
                from_path: r.from_path,
                to_path: r.to_path,
                status_code: r.status_code,
                source: RedirectSource.MANUAL,
                is_active: true,
              },
              select: { id: true },
            });
            batch.created.push(row.id);
          } else {
            const cur = await tx.storeRedirect.findUniqueOrThrow({
              where: { id: r.id! },
              select: {
                id: true,
                to_path: true,
                status_code: true,
                source: true,
                is_active: true,
              },
            });
            batch.updated.push(cur);
            await tx.storeRedirect.update({
              where: { id: r.id! },
              data: {
                to_path: r.to_path,
                status_code: r.status_code,
                source: RedirectSource.MANUAL,
                is_active: true,
              },
            });
          }
        }
        for (const rp of plan.redirects.repoints) {
          const cur = await tx.storeRedirect.findUniqueOrThrow({
            where: { id: rp.id },
            select: {
              id: true,
              to_path: true,
              status_code: true,
              source: true,
              is_active: true,
            },
          });
          batch.updated.push(cur);
          await tx.storeRedirect.update({
            where: { id: rp.id },
            data: { to_path: rp.to_path },
          });
        }
        if (batch.created.length || batch.updated.length)
          await upsertLedger(tx, ctx, {
            entity_type: OCCASION_ENTITY_TYPE,
            external_ref: BATCH_REF(conversionId),
            target_id: null,
            source_hash: plan.fingerprint,
            applied_hash: null,
            created: true,
            status: ImportEntityStatus.ACTIVE,
            payload: batch as unknown as Prisma.InputJsonValue,
          });
      },
      { timeout: TX_TIMEOUT_MS },
    );

    this.redirects.invalidate(storeId);
    await this.revalidation.revalidateStoreById(storeId);
    this.logger.log(
      `occasion conversion ${conversionId} applied on ${storeId}: ${plan.counts.pages.CREATE} pages`,
    );
    return { conversion_id: conversionId, store: storeId, plan };
  }

  /**
   * Restores every row the batch wrote, from the ledger before-images. A
   * page republished since the conversion is kept (its label stays INTERNAL
   * too, so the page keeps working) and reported.
   */
  async rollback(
    storeId: string,
    conversionId: string,
  ): Promise<RollbackReport> {
    const rows = await this.prisma.importEntity.findMany({
      where: {
        store_id: storeId,
        entity_type: OCCASION_ENTITY_TYPE,
        last_run_id: conversionId,
        status: ImportEntityStatus.ACTIVE,
      },
      orderBy: { created_at: 'asc' },
    });
    if (!rows.length) {
      throw new NotFoundException({
        code: 'OCCASION_CONVERSION_NOT_FOUND',
        message: 'No active conversion with this id',
      });
    }
    const report: RollbackReport = {
      conversion_id: conversionId,
      restored: 0,
      kept: [],
      redirects: { deleted: 0, restored: 0 },
    };
    await this.prisma.$transaction(
      async (tx) => {
        const batchRow = rows.find(
          (r) => r.external_ref === BATCH_REF(conversionId),
        );
        const items = rows.filter((r) => r !== batchRow);
        // Pages whose redirects must survive because the page itself is kept.
        const keptPaths = new Set<string>();
        // Rows are restored by id (parent_id is a plain column, the parent
        // row always exists), so the order between parents and children
        // does not matter; reverse creation order is only for readability.
        for (const row of [...items].reverse()) {
          const b = row.payload as unknown as ItemBefore;
          const page = row.target_id
            ? await tx.page.findUnique({
                where: { id: row.target_id },
                select: { id: true, slug: true, published_version_id: true },
              })
            : null;
          if (page && page.published_version_id !== b.version_id) {
            report.kept.push({
              slug: page.slug ?? row.external_ref,
              reason: 'W_ROLLBACK_TARGET_MODIFIED',
            });
            if (page.slug) keptPaths.add(`/${page.slug}`);
            await tx.importEntity.update({
              where: { id: row.id },
              data: { status: ImportEntityStatus.ROLLED_BACK },
            });
            continue;
          }
          const catId = (
            await tx.creatorCategory.findFirst({
              where: {
                creator: { store: { id: storeId } },
                OR: [
                  { external_ref: row.external_ref },
                  { id: row.external_ref.replace(/^cc:/, '') },
                ],
              },
              select: { id: true },
            })
          )?.id;
          for (const m of b.menu_items)
            await tx.menuItem.updateMany({
              where: { id: m.id },
              data: {
                kind: m.kind as MenuItemKind,
                resource_id: m.resource_id,
                url: m.url,
              },
            });
          if (page) await tx.page.delete({ where: { id: page.id } });
          if (!catId)
            report.kept.push({
              slug: page?.slug ?? row.external_ref,
              reason: 'W_ROLLBACK_CATEGORY_MISSING',
            });
          if (catId) {
            await tx.creatorCategory.update({
              where: { id: catId },
              data: {
                visibility: b.category.visibility,
                parent_id: b.category.parent_id,
              },
            });
            const productIds = b.links_added
              .filter((l) => l.entity === 'PRODUCT')
              .map((l) => l.id);
            const customIds = b.links_added
              .filter((l) => l.entity === 'CUSTOM_PRODUCT')
              .map((l) => l.id);
            if (productIds.length)
              await tx.productCreatorCategory.deleteMany({
                where: {
                  creator_category_id: catId,
                  product_id: { in: productIds },
                },
              });
            if (customIds.length)
              await tx.customProductCreatorCategory.deleteMany({
                where: {
                  creator_category_id: catId,
                  custom_product_id: { in: customIds },
                },
              });
            for (const p of b.primaries) {
              if (p.entity === 'PRODUCT')
                await tx.product.updateMany({
                  where: { id: p.id, primary_creator_category_id: p.to },
                  data: { primary_creator_category_id: p.from },
                });
              else
                await tx.customProduct.updateMany({
                  where: { id: p.id, primary_creator_category_id: p.to },
                  data: { primary_creator_category_id: p.from },
                });
            }
          }
          await tx.importEntity.update({
            where: { id: row.id },
            data: { status: ImportEntityStatus.ROLLED_BACK },
          });
          if (catId) report.restored += 1;
        }
        if (batchRow) {
          const b = batchRow.payload as unknown as BatchBefore;
          // Redirects that point at a kept page stay: its collection is gone
          // (INTERNAL), so the old URLs must keep reaching the page.
          const current = await tx.storeRedirect.findMany({
            where: {
              id: { in: [...b.created, ...b.updated.map((u) => u.id)] },
              store_id: storeId,
            },
            select: { id: true, to_path: true },
          });
          const toPathOf = new Map(current.map((r) => [r.id, r.to_path]));
          const keep = (id: string) => keptPaths.has(toPathOf.get(id) ?? '');
          const del = await tx.storeRedirect.deleteMany({
            where: {
              id: { in: b.created.filter((id) => !keep(id)) },
              store_id: storeId,
            },
          });
          report.redirects.deleted = del.count;
          for (const u of b.updated) {
            if (keep(u.id)) continue;
            const res = await tx.storeRedirect.updateMany({
              where: { id: u.id, store_id: storeId },
              data: {
                to_path: u.to_path,
                status_code: u.status_code,
                source: u.source as RedirectSource,
                is_active: u.is_active,
              },
            });
            report.redirects.restored += res.count;
          }
          await tx.importEntity.update({
            where: { id: batchRow.id },
            data: { status: ImportEntityStatus.ROLLED_BACK },
          });
        }
      },
      { timeout: TX_TIMEOUT_MS },
    );
    this.redirects.invalidate(storeId);
    await this.revalidation.revalidateStoreById(storeId);
    return report;
  }

  /** Everything the planner reads, in one consistent snapshot of the store. */
  async loadState(storeId: string): Promise<ConversionState> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        creator_id: true,
        language_config: { select: { primary_locale: true } },
      },
    });
    if (!store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    const primaryLocale = store.language_config?.primary_locale ?? 'en';
    const creatorId = store.creator_id;

    const cats = await this.prisma.creatorCategory.findMany({
      where: { creator_id: creatorId },
      select: {
        id: true,
        slug: true,
        parent_id: true,
        visibility: true,
        is_active: true,
        sort_order: true,
        external_ref: true,
        thumbnail_url: true,
        translations: {
          where: { locale: primaryLocale },
          select: {
            name: true,
            description: true,
            long_description: true,
            meta_title: true,
            meta_desc: true,
          },
        },
        products: {
          select: { product_id: true },
          orderBy: { sort_order: 'asc' },
        },
        custom_products: {
          select: { custom_product_id: true },
          orderBy: { sort_order: 'asc' },
        },
      },
      orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
    });
    const catIds = cats.map((c) => c.id);

    const loadProducts = async (custom: boolean): Promise<StateProduct[]> => {
      if (!catIds.length) return [];
      if (custom) {
        const rows = await this.prisma.customProduct.findMany({
          where: {
            OR: [
              { primary_creator_category_id: { in: catIds } },
              {
                creator_categories: {
                  some: { creator_category_id: { in: catIds } },
                },
              },
            ],
          },
          select: {
            id: true,
            primary_creator_category_id: true,
            creator_categories: {
              select: { creator_category_id: true },
              orderBy: { sort_order: 'asc' },
            },
          },
        });
        return rows.map((r) => ({
          id: r.id,
          primary_creator_category_id: r.primary_creator_category_id,
          linked: r.creator_categories.map((l) => l.creator_category_id),
        }));
      }
      const rows = await this.prisma.product.findMany({
        where: {
          OR: [
            { primary_creator_category_id: { in: catIds } },
            {
              creator_categories: {
                some: { creator_category_id: { in: catIds } },
              },
            },
          ],
        },
        select: {
          id: true,
          primary_creator_category_id: true,
          creator_categories: {
            select: { creator_category_id: true },
            orderBy: { sort_order: 'asc' },
          },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        primary_creator_category_id: r.primary_creator_category_id,
        linked: r.creator_categories.map((l) => l.creator_category_id),
      }));
    };

    const [
      products,
      customProducts,
      pages,
      staticPages,
      redirects,
      menuItems,
      ledger,
    ] = await Promise.all([
      loadProducts(false),
      loadProducts(true),
      this.prisma.page.findMany({
        where: { store_id: storeId },
        select: {
          id: true,
          slug: true,
          type: true,
          status: true,
          published_version_id: true,
        },
      }),
      this.prisma.staticPage.findMany({
        where: { store_id: storeId },
        select: { slug: true },
      }),
      this.prisma.storeRedirect.findMany({
        where: { store_id: storeId },
        select: {
          id: true,
          from_path: true,
          to_path: true,
          status_code: true,
          source: true,
          is_active: true,
        },
      }),
      this.prisma.menuItem.findMany({
        where: { menu: { store_id: storeId } },
        select: {
          id: true,
          menu_id: true,
          parent_id: true,
          kind: true,
          resource_id: true,
          url: true,
        },
      }),
      this.prisma.importEntity.findMany({
        where: { store_id: storeId, entity_type: OCCASION_ENTITY_TYPE },
        select: {
          external_ref: true,
          target_id: true,
          source_hash: true,
          applied_hash: true,
          status: true,
          last_run_id: true,
        },
      }),
    ]);

    return {
      storeId,
      creatorId,
      primaryLocale,
      categories: cats.map((c) => ({
        id: c.id,
        slug: c.slug,
        parent_id: c.parent_id,
        visibility: c.visibility,
        is_active: c.is_active,
        sort_order: c.sort_order,
        external_ref: c.external_ref,
        thumbnail_url: c.thumbnail_url,
        translation: c.translations[0] ?? null,
        product_ids: c.products.map((p) => p.product_id),
        custom_product_ids: c.custom_products.map((p) => p.custom_product_id),
      })),
      products,
      customProducts,
      pages,
      staticPageSlugs: staticPages.map((p) => p.slug),
      redirects: redirects as ExistingRedirectRow[],
      menuItems,
      ledger,
    };
  }
}
