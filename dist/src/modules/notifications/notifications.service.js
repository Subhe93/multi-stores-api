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
exports.NotificationsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let NotificationsService = class NotificationsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findByUser(userId, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [data, total, unread] = await Promise.all([
            this.prisma.notification.findMany({
                where: { user_id: userId },
                skip,
                take: limit,
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.notification.count({ where: { user_id: userId } }),
            this.prisma.notification.count({ where: { user_id: userId, is_read: false } }),
        ]);
        return { data, unread_count: unread, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }
    async markAsRead(id) {
        return this.prisma.notification.update({
            where: { id },
            data: { is_read: true },
        });
    }
    async markAllAsRead(userId) {
        await this.prisma.notification.updateMany({
            where: { user_id: userId, is_read: false },
            data: { is_read: true },
        });
        return { message: 'All notifications marked as read' };
    }
    async create(userId, type, title, body, data) {
        return this.prisma.notification.create({
            data: { user_id: userId, type, title, body, data },
        });
    }
};
exports.NotificationsService = NotificationsService;
exports.NotificationsService = NotificationsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], NotificationsService);
//# sourceMappingURL=notifications.service.js.map