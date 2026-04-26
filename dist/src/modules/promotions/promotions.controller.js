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
exports.PromotionsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const promotions_service_1 = require("./promotions.service");
const promotion_dto_1 = require("./dto/promotion.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let PromotionsController = class PromotionsController {
    promotionsService;
    constructor(promotionsService) {
        this.promotionsService = promotionsService;
    }
    create(userId, role, dto) {
        return this.promotionsService.create(userId, role, dto);
    }
    findMyPromotions(userId, role, page, limit) {
        return this.promotionsService.findByOwner(userId, role, page ? +page : undefined, limit ? +limit : undefined);
    }
    findById(id) {
        return this.promotionsService.findById(id);
    }
    update(id, dto, userId, role) {
        return this.promotionsService.update(id, dto, userId, role);
    }
    delete(id, userId, role) {
        return this.promotionsService.delete(id, userId, role);
    }
    validateCoupon(dto) {
        return this.promotionsService.validateCoupon(dto);
    }
};
exports.PromotionsController = PromotionsController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, decorators_1.CurrentUser)('role')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, promotion_dto_1.CreatePromotionDto]),
    __metadata("design:returntype", void 0)
], PromotionsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, decorators_1.CurrentUser)('role')),
    __param(2, (0, common_1.Query)('page')),
    __param(3, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number]),
    __metadata("design:returntype", void 0)
], PromotionsController.prototype, "findMyPromotions", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PromotionsController.prototype, "findById", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)('id')),
    __param(3, (0, decorators_1.CurrentUser)('role')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, promotion_dto_1.UpdatePromotionDto, String, String]),
    __metadata("design:returntype", void 0)
], PromotionsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)('id')),
    __param(2, (0, decorators_1.CurrentUser)('role')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], PromotionsController.prototype, "delete", null);
__decorate([
    (0, common_1.Post)('validate-coupon'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [promotion_dto_1.ValidateCouponDto]),
    __metadata("design:returntype", void 0)
], PromotionsController.prototype, "validateCoupon", null);
exports.PromotionsController = PromotionsController = __decorate([
    (0, common_1.Controller)('promotions'),
    __metadata("design:paramtypes", [promotions_service_1.PromotionsService])
], PromotionsController);
//# sourceMappingURL=promotions.controller.js.map