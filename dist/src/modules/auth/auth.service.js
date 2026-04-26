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
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const bcrypt = __importStar(require("bcrypt"));
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
let AuthService = class AuthService {
    prisma;
    jwtService;
    configService;
    constructor(prisma, jwtService, configService) {
        this.prisma = prisma;
        this.jwtService = jwtService;
        this.configService = configService;
    }
    async register(dto) {
        const existing = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (existing) {
            throw new common_1.ConflictException('Email already registered');
        }
        if (dto.role === client_1.UserRole.ADMIN) {
            throw new common_1.ForbiddenException('Cannot register as admin');
        }
        const password_hash = await bcrypt.hash(dto.password, 12);
        const user = await this.prisma.user.create({
            data: {
                email: dto.email,
                password_hash,
                role: dto.role,
                status: 'ACTIVE',
            },
            select: {
                id: true,
                email: true,
                role: true,
                status: true,
                created_at: true,
            },
        });
        if (dto.role === client_1.UserRole.CUSTOMER) {
            await this.prisma.customer.create({
                data: {
                    user_id: user.id,
                    first_name: dto.first_name || '',
                    last_name: dto.last_name || '',
                    ...(dto.phone ? { phone: dto.phone } : {}),
                },
            });
        }
        else if (dto.role === client_1.UserRole.PROVIDER) {
            await this.prisma.provider.create({
                data: { user_id: user.id, company_name: dto.first_name || 'My Company', country: 'US' },
            });
        }
        else if (dto.role === client_1.UserRole.CREATOR) {
            await this.prisma.creator.create({
                data: { user_id: user.id, display_name: dto.first_name || 'Creator' },
            });
        }
        const tokens = await this.generateTokens(user.id, user.email, user.role);
        return { user, ...tokens };
    }
    async login(dto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (!user) {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        const passwordValid = await bcrypt.compare(dto.password, user.password_hash);
        if (!passwordValid) {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        if (user.status !== 'ACTIVE') {
            throw new common_1.ForbiddenException('Account is not active');
        }
        const tokens = await this.generateTokens(user.id, user.email, user.role);
        return {
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                status: user.status,
            },
            ...tokens,
        };
    }
    async refreshToken(refreshToken) {
        try {
            const payload = this.jwtService.verify(refreshToken, {
                secret: this.configService.get('JWT_REFRESH_SECRET'),
            });
            const user = await this.prisma.user.findUnique({
                where: { id: payload.sub },
            });
            if (!user || user.status !== 'ACTIVE') {
                throw new common_1.UnauthorizedException();
            }
            return this.generateTokens(user.id, user.email, user.role);
        }
        catch {
            throw new common_1.UnauthorizedException('Invalid refresh token');
        }
    }
    async logout(userId, refreshToken) {
        await this.prisma.session.deleteMany({
            where: { user_id: userId },
        });
        await this.prisma.session.create({
            data: {
                user_id: userId,
                token: refreshToken,
                expires_at: new Date(0),
            },
        });
        return { message: 'Logged out successfully' };
    }
    async forgotPassword(email) {
        const user = await this.prisma.user.findUnique({
            where: { email },
        });
        if (!user) {
            return { message: 'If the email exists, a reset link will be sent' };
        }
        const resetToken = await this.jwtService.signAsync({ sub: user.id, type: 'password_reset' }, {
            secret: this.configService.get('JWT_SECRET'),
            expiresIn: '1h',
        });
        await this.prisma.session.create({
            data: {
                user_id: user.id,
                token: resetToken,
                expires_at: new Date(Date.now() + 60 * 60 * 1000),
            },
        });
        return { message: 'If the email exists, a reset link will be sent' };
    }
    async resetPassword(token, newPassword) {
        try {
            const payload = this.jwtService.verify(token, {
                secret: this.configService.get('JWT_SECRET'),
            });
            if (payload.type !== 'password_reset') {
                throw new common_1.UnauthorizedException('Invalid reset token');
            }
            const session = await this.prisma.session.findUnique({
                where: { token },
            });
            if (!session || session.expires_at < new Date()) {
                throw new common_1.UnauthorizedException('Reset token expired or already used');
            }
            const password_hash = await bcrypt.hash(newPassword, 12);
            await this.prisma.user.update({
                where: { id: payload.sub },
                data: { password_hash },
            });
            await this.prisma.session.delete({ where: { token } });
            return { message: 'Password reset successfully' };
        }
        catch {
            throw new common_1.UnauthorizedException('Invalid or expired reset token');
        }
    }
    async changePassword(userId, currentPassword, newPassword) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.UnauthorizedException('User not found');
        const valid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!valid)
            throw new common_1.UnauthorizedException('Current password is incorrect');
        const password_hash = await bcrypt.hash(newPassword, 12);
        await this.prisma.user.update({
            where: { id: userId },
            data: { password_hash },
        });
        return { message: 'Password changed successfully' };
    }
    async getProfile(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                role: true,
                status: true,
                avatar_url: true,
                created_at: true,
                provider: true,
                creator: true,
                customer: true,
            },
        });
        if (!user) {
            throw new common_1.UnauthorizedException();
        }
        return user;
    }
    async generateTokens(userId, email, role) {
        const payload = { sub: userId, email, role };
        const [access_token, refresh_token] = await Promise.all([
            this.jwtService.signAsync(payload, {
                secret: this.configService.get('JWT_SECRET'),
                expiresIn: this.configService.get('JWT_EXPIRES_IN'),
            }),
            this.jwtService.signAsync(payload, {
                secret: this.configService.get('JWT_REFRESH_SECRET'),
                expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN'),
            }),
        ]);
        return { access_token, refresh_token };
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService,
        config_1.ConfigService])
], AuthService);
//# sourceMappingURL=auth.service.js.map