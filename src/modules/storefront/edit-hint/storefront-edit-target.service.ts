import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoreType, UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorefrontService } from '../storefront.service';
import { EditHintTokenService } from './edit-hint-token.service';
import {
  dashboardUrl,
  parseStorefrontPath,
  type EditLabelKind,
  type EditTargetResponse,
  type StorefrontRoute,
} from './storefront-path';

/** A node of `StorefrontService.getCreatorCategories` as the walk reads it. */
interface CollectionNode {
  id: string;
  slug: string;
  children?: CollectionNode[];
}

const DEFAULT_DASHBOARD_URL = 'http://localhost:3002';

/**
 * Resolves the storefront path the store owner is looking at to the
 * dashboard page that edits it. Every lookup goes through the same
 * StorefrontService reads the storefront pages use, so the button opens
 * exactly the entity the page renders.
 */
@Injectable()
export class StorefrontEditTargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storefront: StorefrontService,
    private readonly tokens: EditHintTokenService,
    private readonly config: ConfigService,
  ) {}

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'EDIT_HINT_INVALID',
      message: 'Edit hint token is invalid or expired',
    });
  }

  /**
   * The owner check: a valid token for THIS store, whose user still exists,
   * is an ACTIVE creator and still owns the (active) store. Anything else is
   * a 401 so the storefront forgets the token.
   */
  async authorize(storeSlug: string, token: string | null) {
    const claims = this.tokens.verify(token);
    if (!claims) throw this.unauthorized();
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      select: {
        id: true,
        slug: true,
        creator_id: true,
        store_type: true,
        is_active: true,
        creator: {
          select: {
            user_id: true,
            user: { select: { role: true, status: true } },
          },
        },
      },
    });
    if (
      !store ||
      !store.is_active ||
      store.id !== claims.store_id ||
      store.creator.user_id !== claims.user_id ||
      store.creator.user.role !== UserRole.CREATOR ||
      store.creator.user.status !== UserStatus.ACTIVE
    ) {
      throw this.unauthorized();
    }
    return store;
  }

  async resolve(
    storeSlug: string,
    token: string | null,
    pathname: string | undefined,
  ): Promise<EditTargetResponse> {
    const store = await this.authorize(storeSlug, token);
    const route = parseStorefrontPath(pathname);
    if (route.kind === 'private') return { edit_url: null, label_kind: null };
    const target = await this.targetFor(store, route);
    const base =
      this.config.get<string>('DASHBOARD_URL') || DEFAULT_DASHBOARD_URL;
    // Unknown paths and entities that no longer resolve fall back to the
    // dashboard home rather than hiding the button.
    const { path, kind } = target ?? {
      path: '/creator',
      kind: 'dashboard' as const,
    };
    return { edit_url: dashboardUrl(base, path), label_kind: kind };
  }

  private async targetFor(
    store: {
      id: string;
      slug: string;
      creator_id: string;
      store_type: StoreType;
    },
    route: StorefrontRoute,
  ): Promise<{ path: string; kind: EditLabelKind } | null> {
    switch (route.kind) {
      case 'home': {
        // The published HOME first (what the page renders), else a draft
        // HOME row; without any, the pages list offers "Edit home".
        const published = await this.storefront.getPublishedPage(store.slug, {
          type: 'HOME',
        });
        const id =
          published?.id ??
          (
            await this.prisma.page.findFirst({
              where: { store_id: store.id, type: 'HOME' },
              select: { id: true },
            })
          )?.id;
        return {
          path: id ? `/builder/${id}` : '/creator/pages',
          kind: 'page',
        };
      }
      case 'catalog': {
        const template = await this.storefront.getPublishedPage(store.slug, {
          type: 'CATALOG_TEMPLATE',
        });
        return template
          ? { path: `/builder/${template.id}`, kind: 'page' }
          : { path: '/creator/products', kind: 'page' };
      }
      case 'product': {
        const ref = await this.storefront.resolveProductRef(store, route.slug);
        if (!ref) return null;
        return {
          path:
            ref.kind === 'own'
              ? `/creator/products/own/${ref.id}`
              : `/creator/custom-products/${ref.id}`,
          kind: 'product',
        };
      }
      case 'collections':
        return { path: '/creator/categories', kind: 'collection' };
      case 'collection': {
        const tree = (await this.storefront.getCreatorCategories(
          store.slug,
        )) as CollectionNode[];
        const leaf = walkCollectionPath(tree, route.path);
        return leaf
          ? { path: `/creator/categories/${leaf.id}`, kind: 'collection' }
          : null;
      }
      case 'page': {
        // Same precedence as the web `[pageSlug]` route: a v2 page with
        // sections wins, else the published legacy StaticPage.
        const [v2, legacy] = await Promise.all([
          this.storefront
            .getPublishedPage(store.slug, { type: 'SLUG', slug: route.slug })
            .catch(() => null),
          this.storefront.getPage(store.slug, route.slug).catch(() => null),
        ]);
        const sections = (v2?.snapshot as { sections?: unknown[] } | null)
          ?.sections;
        if (v2 && Array.isArray(sections) && sections.length > 0) {
          return { path: `/builder/${v2.id}`, kind: 'page' };
        }
        if (legacy)
          return { path: `/creator/pages/${legacy.id}`, kind: 'page' };
        if (v2) return { path: `/builder/${v2.id}`, kind: 'page' };
        return null;
      }
      default:
        return null;
    }
  }
}

/**
 * The collection a hierarchical `/collections/<a>/<b>` path shows: one
 * level per segment, matched by slug — the same walk as the web's
 * `resolveCollectionChain` over the same public tree.
 */
export function walkCollectionPath(
  tree: CollectionNode[],
  segments: string[],
): CollectionNode | null {
  let level = tree;
  let node: CollectionNode | undefined;
  for (const segment of segments) {
    node = level.find((n) => n.slug === segment);
    if (!node) return null;
    level = node.children ?? [];
  }
  return node ?? null;
}
