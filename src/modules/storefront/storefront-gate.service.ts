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

/** Who is reading a storefront: the account behind a valid bearer token. */
export interface StorefrontViewer {
  id: string;
  role: UserRole;
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
  ) {}

  async viewerFromRequest(
    req: ViewerRequest | undefined,
  ): Promise<StorefrontViewer | null> {
    const header = req?.headers?.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    const match = raw?.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    try {
      const secret = this.config.get<string>('JWT_SECRET');
      if (!secret) return null;
      const payload = this.jwt.verify<
        Partial<AuthTokenPayload> & { type?: string; iat?: number }
      >(match[1], { secret });
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
// session secret explicitly. PrismaModule is global.
@Module({
  imports: [JwtModule.register({})],
  providers: [StorefrontGateService, StorefrontViewerGuard],
  exports: [StorefrontGateService, StorefrontViewerGuard],
})
export class StorefrontGateModule {}
