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
exports.CartController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const cart_service_1 = require("./cart.service");
const cart_dto_1 = require("./dto/cart.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let CartController = class CartController {
    cartService;
    constructor(cartService) {
        this.cartService = cartService;
    }
    getCart(userId) {
        return this.cartService.getCart(userId);
    }
    addItem(userId, dto) {
        return this.cartService.addItem(userId, dto);
    }
    updateItem(userId, itemId, dto) {
        return this.cartService.updateItem(userId, itemId, dto);
    }
    removeItem(userId, itemId) {
        return this.cartService.removeItem(userId, itemId);
    }
    clearCart(userId) {
        return this.cartService.clearCart(userId);
    }
    applyCoupon(userId, couponCode) {
        return this.cartService.applyCoupon(userId, couponCode);
    }
    removeCoupon(userId) {
        return this.cartService.removeCoupon(userId);
    }
};
exports.CartController = CartController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CartController.prototype, "getCart", null);
__decorate([
    (0, common_1.Post)('items'),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, cart_dto_1.AddCartItemDto]),
    __metadata("design:returntype", void 0)
], CartController.prototype, "addItem", null);
__decorate([
    (0, common_1.Put)('items/:id'),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, cart_dto_1.UpdateCartItemDto]),
    __metadata("design:returntype", void 0)
], CartController.prototype, "updateItem", null);
__decorate([
    (0, common_1.Delete)('items/:id'),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], CartController.prototype, "removeItem", null);
__decorate([
    (0, common_1.Delete)(),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CartController.prototype, "clearCart", null);
__decorate([
    (0, common_1.Post)('apply-coupon'),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)('coupon_code')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], CartController.prototype, "applyCoupon", null);
__decorate([
    (0, common_1.Delete)('remove-coupon'),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CartController.prototype, "removeCoupon", null);
exports.CartController = CartController = __decorate([
    (0, common_1.Controller)('cart'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.CUSTOMER),
    __metadata("design:paramtypes", [cart_service_1.CartService])
], CartController);
//# sourceMappingURL=cart.controller.js.map