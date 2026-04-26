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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrdersController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const orders_service_1 = require("./orders.service");
const order_dto_1 = require("./dto/order.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let OrdersController = class OrdersController {
    ordersService;
    constructor(ordersService) {
        this.ordersService = ordersService;
    }
    create(userId, dto) {
        return this.ordersService.create(userId, dto);
    }
    findMyOrders(userId, page, limit) {
        return this.ordersService.findByCustomer(userId, page ? +page : undefined, limit ? +limit : undefined);
    }
    async findAll(userId, role, page, limit) {
        if (role === client_1.UserRole.ADMIN) {
            return this.ordersService.findAll(page ? +page : undefined, limit ? +limit : undefined);
        }
        return this.ordersService.findByRole(userId, role, page ? +page : undefined, limit ? +limit : undefined);
    }
    findByFulfiller(fulfillerId, page, limit) {
        return this.ordersService.findByFulfiller(fulfillerId, page ? +page : undefined, limit ? +limit : undefined);
    }
    findById(id) {
        return this.ordersService.findById(id);
    }
    updateStatus(id, dto, userId) {
        return this.ordersService.updateStatus(id, dto, userId);
    }
    updateFulfillment(orderId, itemId, dto) {
        return this.ordersService.updateFulfillment(orderId, itemId, dto);
    }
};
exports.OrdersController = OrdersController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.CUSTOMER),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, order_dto_1.CreateOrderDto]),
    __metadata("design:returntype", void 0)
], OrdersController.prototype, "create", null);
__decorate([
    (0, common_1.Get)('my'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.CUSTOMER),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", void 0)
], OrdersController.prototype, "findMyOrders", null);
__decorate([
    (0, common_1.Get)(),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN, client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, decorators_1.CurrentUser)('role')),
    __param(2, (0, common_1.Query)('page')),
    __param(3, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('fulfiller/:fulfillerId'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('fulfillerId')),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", void 0)
], OrdersController.prototype, "findByFulfiller", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OrdersController.prototype, "findById", null);
__decorate([
    (0, common_1.Put)(':id/status'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, order_dto_1.UpdateOrderStatusDto, String]),
    __metadata("design:returntype", void 0)
], OrdersController.prototype, "updateStatus", null);
__decorate([
    (0, common_1.Put)(':orderId/items/:itemId/fulfillment'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('orderId')),
    __param(1, (0, common_1.Param)('itemId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, order_dto_1.UpdateFulfillmentDto]),
    __metadata("design:returntype", void 0)
], OrdersController.prototype, "updateFulfillment", null);
exports.OrdersController = OrdersController = __decorate([
    (0, common_1.Controller)('orders'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    __metadata("design:paramtypes", [orders_service_1.OrdersService])
], OrdersController);
//# sourceMappingURL=orders.controller.js.map