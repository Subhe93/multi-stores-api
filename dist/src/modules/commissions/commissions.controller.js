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
exports.CommissionsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const commissions_service_1 = require("./commissions.service");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let CommissionsController = class CommissionsController {
    commissionsService;
    constructor(commissionsService) {
        this.commissionsService = commissionsService;
    }
    getSummary(userId, role) {
        const ownerType = role === client_1.UserRole.PROVIDER ? 'provider' : 'creator';
        return this.commissionsService.getSummary(userId, ownerType);
    }
    getPlatformSummary() {
        return this.commissionsService.getPlatformSummary();
    }
    getAdminList(page, limit, status, search) {
        const statusEnum = status && Object.values(client_1.CommissionStatus).includes(status)
            ? status
            : undefined;
        return this.commissionsService.getAdminList({
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20,
            status: statusEnum,
            search: search || undefined,
        });
    }
    getByOrder(orderId) {
        return this.commissionsService.getByOrder(orderId);
    }
};
exports.CommissionsController = CommissionsController;
__decorate([
    (0, common_1.Get)('summary'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, decorators_1.CurrentUser)('role')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], CommissionsController.prototype, "getSummary", null);
__decorate([
    (0, common_1.Get)('platform'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], CommissionsController.prototype, "getPlatformSummary", null);
__decorate([
    (0, common_1.Get)('admin/list'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('status')),
    __param(3, (0, common_1.Query)('search')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], CommissionsController.prototype, "getAdminList", null);
__decorate([
    (0, common_1.Get)('order/:orderId'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('orderId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CommissionsController.prototype, "getByOrder", null);
exports.CommissionsController = CommissionsController = __decorate([
    (0, common_1.Controller)('commissions'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    __metadata("design:paramtypes", [commissions_service_1.CommissionsService])
], CommissionsController);
//# sourceMappingURL=commissions.controller.js.map