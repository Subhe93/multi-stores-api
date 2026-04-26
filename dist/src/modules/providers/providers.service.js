"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProvidersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let ProvidersService = class ProvidersService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(userId, dto) {
        return this.prisma.provider.create({
            data: {
                user_id: userId,
                ...dto,
            },
        });
    }
    async findByUserId(userId) {
        const provider = await this.prisma.provider.findUnique({
            where: { user_id: userId },
        });
        if (!provider)
            throw new common_1.NotFoundException('Provider profile not found');
        return provider;
    }
    async findById(id) {
        const provider = await this.prisma.provider.findUnique({
            where: { id },
            include: { user: { select: { email: true, status: true } } },
        });
        if (!provider)
            throw new common_1.NotFoundException('Provider not found');
        return provider;
    }
    async update(userId, dto) {
        return this.prisma.provider.update({
            where: { user_id: userId },
            data: dto,
        });
    }
    async findAll(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.provider.findMany({
                skip,
                take: limit,
                include: { user: { select: { email: true, status: true } } },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.provider.count(),
        ]);
        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
    async verify(id) {
        return this.prisma.provider.update({
            where: { id },
            data: { verified: true },
        });
    }
};
exports.ProvidersService = ProvidersService;
exports.ProvidersService = ProvidersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProvidersService);
//# sourceMappingURL=providers.service.js.map