import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus, Prisma } from '@prisma/client';
import { MagicLinkService } from '../auth/magic-link.service';
import { AccountCredentialsService } from '../auth/account-credentials.service';
import { AccountLinksService } from '../auth/account-links.service';
import { normalizeEmail } from '../../common/email/email.util';

/** Store summary shown next to a customer account in the admin lists. */
const STORE_SUMMARY = { select: { id: true, name: true, slug: true } } as const;

interface CreateUserPayload {
  email: string;
  password: string;
  role: UserRole;
  status?: UserStatus;
  avatar_url?: string;
  // Provider
  company_name?: string;
  description?: string;
  country?: string;
  phone?: string;
  verified?: boolean;
  // Creator
  display_name?: string;
  bio?: string;
  // Customer: the store the account belongs to (required for CUSTOMER).
  store_id?: string;
  first_name?: string;
  last_name?: string;
  // Mail the login details (typed password + magic link) to the new user.
  send_credentials?: boolean;
  // Language of that email; 'en' when absent.
  locale?: string;
}

interface UpdateUserPayload {
  email?: string;
  status?: UserStatus;
  avatar_url?: string | null;
  // Provider
  company_name?: string;
  description?: string | null;
  country?: string;
  phone?: string | null;
  verified?: boolean;
  logo_url?: string | null;
  // Creator
  display_name?: string;
  bio?: string | null;
  cover_url?: string | null;
  // Customer
  first_name?: string;
  last_name?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private readonly magicLinks: MagicLinkService,
    private readonly credentials: AccountCredentialsService,
    private readonly links: AccountLinksService,
  ) {}

  async findAll(
    page = 1,
    limit = 20,
    filters?: {
      role?: UserRole;
      status?: UserStatus;
      search?: string;
      store_id?: string;
    },
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.UserWhereInput = {};

    if (filters?.role) where.role = filters.role;
    if (filters?.status) where.status = filters.status;
    if (filters?.store_id) where.store_id = filters.store_id;
    if (filters?.search) {
      where.email = { contains: filters.search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        where,
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          avatar_url: true,
          store_id: true,
          store: STORE_SUMMARY,
          created_at: true,
          provider: { select: { company_name: true, verified: true } },
          creator: { select: { display_name: true, verified: true } },
          customer: { select: { first_name: true, last_name: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        avatar_url: true,
        store_id: true,
        store: STORE_SUMMARY,
        created_at: true,
        updated_at: true,
        provider: true,
        // Never ship the Kustom shared secret, not even as ciphertext.
        creator: { omit: { kustom_shared_secret: true } },
        customer: { include: { addresses: true } },
      },
    });

    if (!user)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    return user;
  }

  async create(dto: CreateUserPayload) {
    if (!dto.email || !dto.password || !dto.role) {
      throw new BadRequestException({
        code: 'USER_MISSING_REQUIRED_FIELDS',
        message: 'email, password and role are required',
      });
    }
    if (dto.password.length < 8) {
      throw new BadRequestException({
        code: 'USER_PASSWORD_TOO_SHORT',
        message: 'Password must be at least 8 characters',
      });
    }

    // Customer accounts belong to one store; staff to none.
    const isCustomer = dto.role === UserRole.CUSTOMER;
    if (isCustomer && !dto.store_id) {
      throw new BadRequestException({
        code: 'STORE_REQUIRED',
        message: 'A customer account needs a store_id',
      });
    }
    const store = isCustomer
      ? await this.prisma.store.findUnique({
          where: { id: dto.store_id },
          select: { id: true, slug: true },
        })
      : null;
    if (isCustomer && !store) {
      throw new BadRequestException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    const storeId = store?.id ?? null;
    const email = normalizeEmail(dto.email);

    if (await this.emailTaken(email, storeId))
      throw new ConflictException({
        code: 'USER_EMAIL_EXISTS',
        message: 'Email already registered',
      });

    const password_hash = await bcrypt.hash(dto.password, 12);

    let user: {
      id: string;
      email: string;
      role: UserRole;
      status: UserStatus;
      avatar_url: string | null;
      created_at: Date;
    };
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          password_hash,
          role: dto.role,
          status: dto.status ?? UserStatus.ACTIVE,
          avatar_url: dto.avatar_url,
          store_id: storeId,
        },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          avatar_url: true,
          created_at: true,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException({
          code: 'USER_EMAIL_EXISTS',
          message: 'Email already registered',
        });
      throw err;
    }

    if (dto.role === UserRole.PROVIDER) {
      await this.prisma.provider.create({
        data: {
          user_id: user.id,
          company_name: dto.company_name || 'New Company',
          description: dto.description,
          country: dto.country || 'US',
          phone: dto.phone,
          verified: dto.verified ?? false,
        },
      });
    } else if (dto.role === UserRole.CREATOR) {
      await this.prisma.creator.create({
        data: {
          user_id: user.id,
          display_name: dto.display_name || 'New Creator',
          bio: dto.bio,
          phone: dto.phone,
          verified: dto.verified ?? false,
        },
      });
    } else if (dto.role === UserRole.CUSTOMER) {
      await this.prisma.customer.create({
        data: {
          user_id: user.id,
          first_name: dto.first_name || '',
          last_name: dto.last_name || '',
          phone: dto.phone,
        },
      });
    }

    // Login details by email: the password the admin typed plus a one-click
    // link (dashboard for staff roles, the customer's own store for
    // customers, branded with that store while it is live). Off the
    // response path and never echoed back.
    if (dto.send_credentials) {
      const name =
        dto.first_name || dto.display_name || dto.company_name || null;
      const created = user;
      void (async () => {
        const ctx = store ? await this.links.resolveStore(store.slug) : null;
        const live = ctx?.isActive ? ctx : null;
        await this.credentials.send({
          user: { id: created.id, email: created.email, role: created.role },
          name,
          password: dto.password,
          store: live ? { id: live.id, name: live.name } : null,
          storeBase: live?.base ?? null,
          locale: dto.locale || live?.primaryLocale || 'en',
        });
      })().catch(() => undefined);
    }

    return this.findById(user.id);
  }

  async update(id: string, dto: UpdateUserPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { provider: true, creator: true, customer: true },
    });
    if (!user)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });

    // The email only has to be free where the account lives: within its
    // store for a customer, among staff otherwise.
    const nextEmail =
      dto.email !== undefined ? normalizeEmail(dto.email) : undefined;
    if (nextEmail && nextEmail !== user.email) {
      if (await this.emailTaken(nextEmail, user.store_id, id))
        throw new ConflictException({
          code: 'USER_EMAIL_IN_USE',
          message: 'Email already in use',
        });
    }

    const userUpdate: Record<string, any> = {};
    if (nextEmail) userUpdate.email = nextEmail;
    if (dto.status !== undefined) {
      userUpdate.status = dto.status;
      // Any non-ACTIVE status revokes every token issued so far.
      if (dto.status !== UserStatus.ACTIVE) {
        userUpdate.tokens_valid_after = new Date();
      }
    }
    if (dto.avatar_url !== undefined) userUpdate.avatar_url = dto.avatar_url;

    if (Object.keys(userUpdate).length > 0) {
      try {
        await this.prisma.user.update({ where: { id }, data: userUpdate });
      } catch (err) {
        if (isUniqueViolation(err))
          throw new ConflictException({
            code: 'USER_EMAIL_IN_USE',
            message: 'Email already in use',
          });
        throw err;
      }
    }

    if (user.role === UserRole.PROVIDER && user.provider) {
      const providerUpdate: Record<string, any> = {};
      if (dto.company_name !== undefined)
        providerUpdate.company_name = dto.company_name;
      if (dto.description !== undefined)
        providerUpdate.description = dto.description;
      if (dto.country !== undefined) providerUpdate.country = dto.country;
      if (dto.phone !== undefined) providerUpdate.phone = dto.phone;
      if (dto.verified !== undefined) providerUpdate.verified = dto.verified;
      if (dto.logo_url !== undefined) providerUpdate.logo_url = dto.logo_url;
      if (Object.keys(providerUpdate).length > 0) {
        await this.prisma.provider.update({
          where: { id: user.provider.id },
          data: providerUpdate,
        });
      }
    } else if (user.role === UserRole.CREATOR && user.creator) {
      const creatorUpdate: Record<string, any> = {};
      if (dto.display_name !== undefined)
        creatorUpdate.display_name = dto.display_name;
      if (dto.bio !== undefined) creatorUpdate.bio = dto.bio;
      if (dto.phone !== undefined) creatorUpdate.phone = dto.phone;
      if (dto.verified !== undefined) creatorUpdate.verified = dto.verified;
      if (dto.avatar_url !== undefined)
        creatorUpdate.avatar_url = dto.avatar_url;
      if (dto.cover_url !== undefined) creatorUpdate.cover_url = dto.cover_url;
      if (Object.keys(creatorUpdate).length > 0) {
        await this.prisma.creator.update({
          where: { id: user.creator.id },
          data: creatorUpdate,
        });
      }
    } else if (user.role === UserRole.CUSTOMER && user.customer) {
      const customerUpdate: Record<string, any> = {};
      if (dto.first_name !== undefined)
        customerUpdate.first_name = dto.first_name;
      if (dto.last_name !== undefined) customerUpdate.last_name = dto.last_name;
      if (dto.phone !== undefined) customerUpdate.phone = dto.phone;
      if (Object.keys(customerUpdate).length > 0) {
        await this.prisma.customer.update({
          where: { id: user.customer.id },
          data: customerUpdate,
        });
      }
    }

    return this.findById(id);
  }

  async updateStatus(id: string, status: UserStatus) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });

    return this.prisma.user.update({
      where: { id },
      // Any non-ACTIVE status revokes every token issued so far, so a later
      // re-activation does not bring the old sessions back.
      data:
        status === UserStatus.ACTIVE
          ? { status }
          : { status, tokens_valid_after: new Date() },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
      },
    });
  }

  async resetPassword(id: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException({
        code: 'USER_PASSWORD_TOO_SHORT',
        message: 'Password must be at least 8 characters',
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });

    const password_hash = await bcrypt.hash(newPassword, 12);

    await this.prisma.user.update({
      where: { id },
      data: { password_hash, tokens_valid_after: new Date() },
    });

    // Invalidate all active sessions so the user is forced to re-login, and
    // any mailed magic link sent with the previous password.
    await this.prisma.session.deleteMany({ where: { user_id: id } });
    await this.magicLinks.invalidateForUser(id);

    return { message: 'Password reset successfully' };
  }

  async remove(id: string, actingUserId: string) {
    if (id === actingUserId) {
      throw new ForbiddenException({
        code: 'USER_CANNOT_DELETE_SELF',
        message: 'You cannot delete your own account',
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });

    if (user.role === UserRole.ADMIN) {
      const adminCount = await this.prisma.user.count({
        where: { role: UserRole.ADMIN },
      });
      if (adminCount <= 1) {
        throw new ForbiddenException({
          code: 'USER_CANNOT_DELETE_LAST_ADMIN',
          message: 'Cannot delete the last admin account',
        });
      }
    }

    await this.prisma.user.delete({ where: { id } });

    return { message: 'User deleted successfully' };
  }

  async getDashboardStats() {
    const [
      totalUsers,
      totalProviders,
      totalCreators,
      totalCustomers,
      pendingProviders,
      pendingCreators,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.provider.count(),
      this.prisma.creator.count(),
      this.prisma.customer.count(),
      this.prisma.provider.count({ where: { verified: false } }),
      this.prisma.creator.count({ where: { verified: false } }),
    ]);

    return {
      totalUsers,
      totalProviders,
      totalCreators,
      totalCustomers,
      pendingProviders,
      pendingCreators,
    };
  }

  async getPlatformConfig() {
    let config = await this.prisma.platformConfig.findFirst();
    if (!config) {
      config = await this.prisma.platformConfig.create({ data: {} });
    }
    // This endpoint is readable by providers/creators, so never expose the
    // platform Stripe/SMTP credentials here. They are managed via the admin-only
    // payments / mail settings APIs instead.
    const {
      stripe_secret_key: _s,
      stripe_publishable_key: _p,
      stripe_webhook_secret: _w,
      smtp_host: _sh,
      smtp_port: _sp,
      smtp_secure: _ss,
      smtp_user: _su,
      smtp_pass: _spw,
      mail_from: _mf,
      ...safe
    } = config;
    void _s;
    void _p;
    void _w;
    void _sh;
    void _sp;
    void _ss;
    void _su;
    void _spw;
    void _mf;
    return safe;
  }

  async updatePlatformConfig(data: {
    commission_type?: string;
    commission_value?: number;
    default_currency?: string;
    default_locale?: string;
    supported_locales?: string[];
    platform_name?: string;
    support_email?: string;
    min_order_amount?: number | null;
    require_provider_approval?: boolean;
    require_creator_approval?: boolean;
  }) {
    // Tax settings live in the TaxRate table and /taxes/admin/settings; the
    // legacy default_tax_rate_bp is no longer accepted here.
    if ('default_tax_rate_bp' in data) {
      delete (data as Record<string, unknown>).default_tax_rate_bp;
    }
    const config = await this.prisma.platformConfig.findFirst();
    if (!config) {
      return this.prisma.platformConfig.create({
        data: data as Prisma.PlatformConfigCreateInput,
      });
    }
    return this.prisma.platformConfig.update({
      where: { id: config.id },
      data,
    });
  }

  /**
   * Whether `email` is used by another account in the same scope: the
   * customers of `storeId`, or the staff accounts (store_id NULL, which is
   * what the partial unique index `User_staff_email_key` covers).
   */
  private async emailTaken(
    email: string,
    storeId: string | null,
    exceptId?: string,
  ): Promise<boolean> {
    const row = await this.prisma.user.findFirst({
      where: {
        store_id: storeId,
        email: { equals: email, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    return row !== null;
  }

  async getRecentUsers(limit = 5) {
    return this.prisma.user.findMany({
      take: limit,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        store_id: true,
        store: STORE_SUMMARY,
        created_at: true,
        provider: { select: { company_name: true } },
        creator: { select: { display_name: true } },
        customer: { select: { first_name: true, last_name: true } },
      },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
