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
exports.CustomersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let CustomersService = class CustomersService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(userId, dto) {
        return this.prisma.customer.create({
            data: { user_id: userId, ...dto },
        });
    }
    async findByUserId(userId) {
        const customer = await this.ensureCustomer(userId);
        return this.prisma.customer.findUnique({
            where: { id: customer.id },
            include: { addresses: true },
        });
    }
    async update(userId, dto) {
        return this.prisma.customer.update({
            where: { user_id: userId },
            data: dto,
        });
    }
    async ensureCustomer(userId) {
        let customer = await this.prisma.customer.findUnique({
            where: { user_id: userId },
        });
        if (!customer) {
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            customer = await this.prisma.customer.create({
                data: {
                    user_id: userId,
                    first_name: user?.email?.split('@')[0] || '',
                    last_name: '',
                },
            });
        }
        return customer;
    }
    async addAddress(userId, dto) {
        const customer = await this.ensureCustomer(userId);
        return this.prisma.address.create({
            data: { customer_id: customer.id, ...dto },
        });
    }
    async getAddresses(userId) {
        const customer = await this.ensureCustomer(userId);
        return this.prisma.address.findMany({
            where: { customer_id: customer.id },
            orderBy: { is_default: 'desc' },
        });
    }
    async deleteAddress(userId, addressId) {
        const customer = await this.ensureCustomer(userId);
        return this.prisma.address.delete({
            where: { id: addressId, customer_id: customer.id },
        });
    }
};
exports.CustomersService = CustomersService;
exports.CustomersService = CustomersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CustomersService);
//# sourceMappingURL=customers.service.js.map