"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsersService = void 0;
const common_1 = require("@nestjs/common");
const bcrypt = __importStar(require("bcrypt"));
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
let UsersService = class UsersService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findAll(page = 1, limit = 20, filters) {
        const skip = (page - 1) * limit;
        const where = {};
        if (filters?.role)
            where.role = filters.role;
        if (filters?.status)
            where.status = filters.status;
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
    async findById(id) {
        const user = await this.prisma.user.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                role: true,
                status: true,
                avatar_url: true,
                created_at: true,
                updated_at: true,
                provider: true,
                creator: true,
                customer: { include: { addresses: true } },
            },
        });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        return user;
    }
    async create(dto) {
        if (!dto.email || !dto.password || !dto.role) {
            throw new common_1.BadRequestException('email, password and role are required');
        }
        if (dto.password.length < 8) {
            throw new common_1.BadRequestException('Password must be at least 8 characters');
        }
        const existing = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (existing)
            throw new common_1.ConflictException('Email already registered');
        const password_hash = await bcrypt.hash(dto.password, 12);
        const user = await this.prisma.user.create({
            data: {
                email: dto.email,
                password_hash,
                role: dto.role,
                status: dto.status ?? client_1.UserStatus.ACTIVE,
                avatar_url: dto.avatar_url,
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
        if (dto.role === client_1.UserRole.PROVIDER) {
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
        }
        else if (dto.role === client_1.UserRole.CREATOR) {
            await this.prisma.creator.create({
                data: {
                    user_id: user.id,
                    display_name: dto.display_name || 'New Creator',
                    bio: dto.bio,
                    phone: dto.phone,
                    verified: dto.verified ?? false,
                },
            });
        }
        else if (dto.role === client_1.UserRole.CUSTOMER) {
            await this.prisma.customer.create({
                data: {
                    user_id: user.id,
                    first_name: dto.first_name || '',
                    last_name: dto.last_name || '',
                    phone: dto.phone,
                },
            });
        }
        return this.findById(user.id);
    }
    async update(id, dto) {
        const user = await this.prisma.user.findUnique({
            where: { id },
            include: { provider: true, creator: true, customer: true },
        });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        if (dto.email && dto.email !== user.email) {
            const conflict = await this.prisma.user.findUnique({
                where: { email: dto.email },
            });
            if (conflict)
                throw new common_1.ConflictException('Email already in use');
        }
        const userUpdate = {};
        if (dto.email !== undefined)
            userUpdate.email = dto.email;
        if (dto.status !== undefined)
            userUpdate.status = dto.status;
        if (dto.avatar_url !== undefined)
            userUpdate.avatar_url = dto.avatar_url;
        if (Object.keys(userUpdate).length > 0) {
            await this.prisma.user.update({ where: { id }, data: userUpdate });
        }
        if (user.role === client_1.UserRole.PROVIDER && user.provider) {
            const providerUpdate = {};
            if (dto.company_name !== undefined)
                providerUpdate.company_name = dto.company_name;
            if (dto.description !== undefined)
                providerUpdate.description = dto.description;
            if (dto.country !== undefined)
                providerUpdate.country = dto.country;
            if (dto.phone !== undefined)
                providerUpdate.phone = dto.phone;
            if (dto.verified !== undefined)
                providerUpdate.verified = dto.verified;
            if (dto.logo_url !== undefined)
                providerUpdate.logo_url = dto.logo_url;
            if (Object.keys(providerUpdate).length > 0) {
                await this.prisma.provider.update({
                    where: { id: user.provider.id },
                    data: providerUpdate,
                });
            }
        }
        else if (user.role === client_1.UserRole.CREATOR && user.creator) {
            const creatorUpdate = {};
            if (dto.display_name !== undefined)
                creatorUpdate.display_name = dto.display_name;
            if (dto.bio !== undefined)
                creatorUpdate.bio = dto.bio;
            if (dto.phone !== undefined)
                creatorUpdate.phone = dto.phone;
            if (dto.verified !== undefined)
                creatorUpdate.verified = dto.verified;
            if (dto.avatar_url !== undefined)
                creatorUpdate.avatar_url = dto.avatar_url;
            if (dto.cover_url !== undefined)
                creatorUpdate.cover_url = dto.cover_url;
            if (Object.keys(creatorUpdate).length > 0) {
                await this.prisma.creator.update({
                    where: { id: user.creator.id },
                    data: creatorUpdate,
                });
            }
        }
        else if (user.role === client_1.UserRole.CUSTOMER && user.customer) {
            const customerUpdate = {};
            if (dto.first_name !== undefined)
                customerUpdate.first_name = dto.first_name;
            if (dto.last_name !== undefined)
                customerUpdate.last_name = dto.last_name;
            if (dto.phone !== undefined)
                customerUpdate.phone = dto.phone;
            if (Object.keys(customerUpdate).length > 0) {
                await this.prisma.customer.update({
                    where: { id: user.customer.id },
                    data: customerUpdate,
                });
            }
        }
        return this.findById(id);
    }
    async updateStatus(id, status) {
        const user = await this.prisma.user.findUnique({ where: { id } });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        return this.prisma.user.update({
            where: { id },
            data: { status },
            select: {
                id: true,
                email: true,
                role: true,
                status: true,
            },
        });
    }
    async resetPassword(id, newPassword) {
        if (!newPassword || newPassword.length < 8) {
            throw new common_1.BadRequestException('Password must be at least 8 characters');
        }
        const user = await this.prisma.user.findUnique({ where: { id } });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        const password_hash = await bcrypt.hash(newPassword, 12);
        await this.prisma.user.update({
            where: { id },
            data: { password_hash },
        });
        await this.prisma.session.deleteMany({ where: { user_id: id } });
        return { message: 'Password reset successfully' };
    }
    async remove(id, actingUserId) {
        if (id === actingUserId) {
            throw new common_1.ForbiddenException('You cannot delete your own account');
        }
        const user = await this.prisma.user.findUnique({ where: { id } });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        if (user.role === client_1.UserRole.ADMIN) {
            const adminCount = await this.prisma.user.count({
                where: { role: client_1.UserRole.ADMIN },
            });
            if (adminCount <= 1) {
                throw new common_1.ForbiddenException('Cannot delete the last admin account');
            }
        }
        await this.prisma.user.delete({ where: { id } });
        return { message: 'User deleted successfully' };
    }
    async getDashboardStats() {
        const [totalUsers, totalProviders, totalCreators, totalCustomers, pendingProviders, pendingCreators] = await Promise.all([
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
        return config;
    }
    async updatePlatformConfig(data) {
        let config = await this.prisma.platformConfig.findFirst();
        if (!config) {
            return this.prisma.platformConfig.create({ data: data });
        }
        return this.prisma.platformConfig.update({
            where: { id: config.id },
            data,
        });
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
                created_at: true,
                provider: { select: { company_name: true } },
                creator: { select: { display_name: true } },
                customer: { select: { first_name: true, last_name: true } },
            },
        });
    }
};
exports.UsersService = UsersService;
exports.UsersService = UsersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UsersService);
//# sourceMappingURL=users.service.js.map