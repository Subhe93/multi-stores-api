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
exports.ShippingController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const shipping_service_1 = require("./shipping.service");
const shipping_dto_1 = require("./dto/shipping.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let ShippingController = class ShippingController {
    shippingService;
    constructor(shippingService) {
        this.shippingService = shippingService;
    }
    createProfile(userId, role, dto) {
        const ownerType = role === client_1.UserRole.PROVIDER ? 'provider' : 'creator';
        return this.shippingService.createProfile(userId, ownerType, dto);
    }
    getProfiles(userId, role) {
        const ownerType = role === client_1.UserRole.PROVIDER ? 'provider' : 'creator';
        return this.shippingService.getProfiles(userId, ownerType);
    }
    addZone(profileId, dto) {
        return this.shippingService.addZone(profileId, dto);
    }
    updateZone(id, dto) {
        return this.shippingService.updateZone(id, dto);
    }
    setDefaultProfile(id, userId, role) {
        const ownerType = role === client_1.UserRole.PROVIDER ? 'provider' : 'creator';
        return this.shippingService.setDefaultProfile(id, userId, ownerType);
    }
    deleteProfile(id, userId, role) {
        const ownerType = role === client_1.UserRole.PROVIDER ? 'provider' : 'creator';
        return this.shippingService.deleteProfile(id, userId, ownerType);
    }
    deleteZone(id) {
        return this.shippingService.deleteZone(id);
    }
    calculate(dto) {
        return this.shippingService.calculate(dto);
    }
    estimate(dto) {
        return this.shippingService.calculateForItems(dto);
    }
};
exports.ShippingController = ShippingController;
__decorate([
    (0, common_1.Post)('profiles'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, decorators_1.CurrentUser)('role')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, shipping_dto_1.CreateShippingProfileDto]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "createProfile", null);
__decorate([
    (0, common_1.Get)('profiles'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, decorators_1.CurrentUser)('role')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "getProfiles", null);
__decorate([
    (0, common_1.Post)('profiles/:profileId/zones'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('profileId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, shipping_dto_1.CreateShippingZoneDto]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "addZone", null);
__decorate([
    (0, common_1.Put)('zones/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "updateZone", null);
__decorate([
    (0, common_1.Put)('profiles/:id/default'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)('id')),
    __param(2, (0, decorators_1.CurrentUser)('role')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "setDefaultProfile", null);
__decorate([
    (0, common_1.Delete)('profiles/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)('id')),
    __param(2, (0, decorators_1.CurrentUser)('role')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "deleteProfile", null);
__decorate([
    (0, common_1.Delete)('zones/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "deleteZone", null);
__decorate([
    (0, common_1.Post)('calculate'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [shipping_dto_1.CalculateShippingDto]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "calculate", null);
__decorate([
    (0, common_1.Post)('estimate'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [shipping_dto_1.EstimateShippingDto]),
    __metadata("design:returntype", void 0)
], ShippingController.prototype, "estimate", null);
exports.ShippingController = ShippingController = __decorate([
    (0, common_1.Controller)('shipping'),
    __metadata("design:paramtypes", [shipping_service_1.ShippingService])
], ShippingController);
//# sourceMappingURL=shipping.controller.js.map