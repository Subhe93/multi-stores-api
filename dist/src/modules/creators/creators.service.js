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
exports.CreatorsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let CreatorsService = class CreatorsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(userId, dto) {
        return this.prisma.creator.create({
            data: {
                user_id: userId,
                ...dto,
            },
        });
    }
    async findByUserId(userId) {
        const creator = await this.prisma.creator.findUnique({
            where: { user_id: userId },
        });
        if (!creator)
            throw new common_1.NotFoundException('Creator profile not found');
        return creator;
    }
    async findById(id) {
        const creator = await this.prisma.creator.findUnique({
            where: { id },
            include: { user: { select: { email: true, status: true } } },
        });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        return creator;
    }
    async update(userId, dto) {
        return this.prisma.creator.update({
            where: { user_id: userId },
            data: dto,
        });
    }
    async findAll(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.creator.findMany({
                skip,
                take: limit,
                include: { user: { select: { email: true, status: true } } },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.creator.count(),
        ]);
        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
    async verify(id) {
        return this.prisma.creator.update({
            where: { id },
            data: { verified: true },
        });
    }
};
exports.CreatorsService = CreatorsService;
exports.CreatorsService = CreatorsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CreatorsService);
//# sourceMappingURL=creators.service.js.map