import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Module,
  createParamDecorator,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { StoreStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  tokenIssuedAfterCutoff,
  tokenStoreMatches,
  type AuthTokenPayload,
} from '../auth/auth.service';
import { loginAllowed } from '../auth/magic-link.service';
import { EditHintTokenModule } from './edit-hint/edit-hint-token.module';
import { EditHintTokenService } from './edit-hint/edit-hint-token.service';

/** The account behind a valid session JWT (dashboard / storefront login). */
export interface SessionViewer {
  id: string;
  role: UserRole;
  kind?: undefined;
}

/**
 * The owner of ONE store, proven by the dashboard-issued edit-hint token
 * (the storefront never holds the dashboard session JWT: other origin).
 * Grants nothing beyond previewing that single store: no admin powers, no
 * other store.
 */
export interface EditHintViewer {
  kind: 'edit-hint';
  store_id: string;
  user_id: string;
}

/** Who is reading a storefront: the principal behind a valid bearer token. */
export type StorefrontViewer = SessionViewer | EditHintViewer;

export function isEditHintViewer(
  viewer: StorefrontViewer | null | undefined,
): viewer is EditHintViewer {
  return viewer?.kind === 'edit-hint';
}

/** Statuses the owner may preview; SUSPENDED stays closed (admins only). */
const OWNER_PREVIEW_STATUSES: ReadonlySet<StoreStatus> = new Set([
  StoreStatus.DRAFT,
  StoreStatus.PENDING_REVIEW,
  StoreStatus.CHANGES_REQUESTED,
  StoreStatus.PAUSED,
]);

interface ViewerRequest {
  headers?: Record<string, string | string[] | undefined>;
  storefrontViewer?: StorefrontViewer | null;
}

/**
 * Public gate of the storefront read endpoints (SPEC §3, owner preview).
 * `viewerFromRequest` is an optional-auth resolver that never throws: a
 * missing, malformed, expired or revoked token simply means "anonymous".
 * The bearer is a session JWT or, failing that, the edit-hint token the
 * dashboard hands the storefront (owner of exactly one store).
 * `allows` decides whether a store may be served to that viewer: LIVE is
 * public; a non-LIVE store is served to its owner (DRAFT / PENDING_REVIEW /
 * CHANGES_REQUESTED / PAUSED) and to admins, closed to everyone else.
 */
@Injectable()
export class StorefrontGateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly editHints: EditHintTokenService,
  ) {}

  async viewerFromRequest(
    req: ViewerRequest | undefined,
  ): Promise<StorefrontViewer | null> {
    return this.viewerFromHeader(req?.headers?.authorization);
  }

  /**
   * The viewer behind a `Bearer <token>` header value (session JWT, else
   * edit-hint token), or null. Same verification as StorefrontViewerGuard;
   * used where the Authorization header carries another identity (checkout:
   * `X-Storefront-Viewer` next to the customer JWT). Never throws.
   */
  async viewerFromHeader(
    header: string | string[] | undefined,
  ): Promise<StorefrontViewer | null> {
    const raw = Array.isArray(header) ? header[0] : header;
    const match = raw?.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const session = await this.sessionViewer(match[1]);
    if (session) return session;
    return this.editHintViewer(match[1]);
  }

  /** The account of a valid session JWT, or null. Never throws. */
  private async sessionViewer(token: string): Promise<SessionViewer | null> {
    try {
      const secret = this.config.get<string>('JWT_SECRET');
      if (!secret) return null;
      const payload = this.jwt.verify<
        Partial<AuthTokenPayload> & { type?: string; iat?: number }
      >(token, { secret });
      if (!payload.sub || payload.type !== undefined) return null;
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          role: true,
          status: true,
          store_id: true,
          tokens_valid_after: true,
        },
      });
      if (!user || !loginAllowed(user)) return null;
      if (!tokenStoreMatches(payload, user)) return null;
      if (!tokenIssuedAfterCutoff(payload, user)) return null;
      return { id: user.id, role: user.role };
    } catch {
      return null;
    }
  }

  /**
   * The owner behind a valid edit-hint token, or null. One query confirms
   * the claimed user is still the owning creator of the claimed store and
   * may still log in (ACTIVE, or PENDING for staff). The token carries no
   * `iat` revocation semantics (own derived secret, own expiry), so no
   * `tokens_valid_after` cutoff applies. Never throws.
   */
  private async editHintViewer(token: string): Promise<EditHintViewer | null> {
    try {
      const claims = this.editHints.verify(token);
      if (!claims) return null;
      const own = await this.prisma.store.findFirst({
        where: { id: claims.store_id, creator: { user_id: claims.user_id } },
        select: {
          id: true,
          creator: {
            select: { user: { select: { role: true, status: true } } },
          },
        },
      });
      const user = own?.creator?.user;
      if (!own || !user) return null;
      if (user.role !== UserRole.CREATOR || !loginAllowed(user)) return null;
      return { kind: 'edit-hint', store_id: own.id, user_id: claims.user_id };
    } catch {
      return null;
    }
  }

  /**
   * Whether `viewer` is the owner of `storeId` (session or edit-hint) or an
   * admin: the people allowed to preview a store's checkout, including a
   * TEST-mode own Stripe key. Never throws.
   */
  async isOwnerOrAdmin(
    storeId: string,
    viewer: StorefrontViewer | null | undefined,
  ): Promise<boolean> {
    if (!viewer) return false;
    if (isEditHintViewer(viewer)) return viewer.store_id === storeId;
    if (viewer.role === UserRole.ADMIN) return true;
    if (viewer.role !== UserRole.CREATOR) return false;
    try {
      const own = await this.prisma.store.findFirst({
        where: { id: storeId, creator: { user_id: viewer.id } },
        select: { id: true },
      });
      return own !== null;
    } catch {
      return false;
    }
  }

  /**
   * Whether `store` may be served to `viewer`. `status` undefined is treated
   * as LIVE (rows always carry it; lean fixtures may not).
   */
  async allows(
    store: { id: string; status?: StoreStatus },
    viewer: StorefrontViewer | null | undefined,
  ): Promise<boolean> {
    if (store.status === undefined || store.status === StoreStatus.LIVE) {
      return true;
    }
    if (!viewer) return false;
    if (isEditHintViewer(viewer)) {
      // Ownership was proven when the viewer was resolved; the token is
      // good for that one store only (never admin, never another store).
      return (
        OWNER_PREVIEW_STATUSES.has(store.status) && store.id === viewer.store_id
      );
    }
    if (viewer.role === UserRole.ADMIN) return true;
    if (!OWNER_PREVIEW_STATUSES.has(store.status)) return false;
    if (viewer.role !== UserRole.CREATOR) return false;
    const own = await this.prisma.store.findFirst({
      where: { id: store.id, creator: { user_id: viewer.id } },
      select: { id: true },
    });
    return own !== null;
  }
}

/**
 * Attaches `req.storefrontViewer` (or null) to every request of a public
 * storefront controller; always lets the request through.
 */
@Injectable()
export class StorefrontViewerGuard implements CanActivate {
  constructor(private readonly gate: StorefrontGateService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ViewerRequest>();
    req.storefrontViewer = await this.gate.viewerFromRequest(req);
    return true;
  }
}

/** `@Viewer() viewer: StorefrontViewer | null` after StorefrontViewerGuard. */
export const Viewer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): StorefrontViewer | null =>
    ctx.switchToHttp().getRequest<ViewerRequest>().storefrontViewer ?? null,
);

// Own JwtModule instance without a default secret: verification passes the
// session secret explicitly. PrismaModule is global. EditHintTokenModule
// (imports JwtModule only, no cycle) verifies the dashboard owner token.
@Module({
  imports: [JwtModule.register({}), EditHintTokenModule],
  providers: [StorefrontGateService, StorefrontViewerGuard],
  exports: [StorefrontGateService, StorefrontViewerGuard],
})
export class StorefrontGateModule {}
