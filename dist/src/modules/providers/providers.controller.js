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
exports.ProvidersController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const providers_service_1 = require("./providers.service");
const create_provider_dto_1 = require("./dto/create-provider.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let ProvidersController = class ProvidersController {
    providersService;
    constructor(providersService) {
        this.providersService = providersService;
    }
    create(userId, dto) {
        return this.providersService.create(userId, dto);
    }
    getMyProfile(userId) {
        return this.providersService.findByUserId(userId);
    }
    updateMyProfile(userId, dto) {
        return this.providersService.update(userId, dto);
    }
    getMyStores(userId, page, limit) {
        return this.providersService.findStoresUsingProvider(userId, page, limit);
    }
    getMyStoreById(userId, storeId) {
        return this.providersService.findStoreForProvider(userId, storeId);
    }
    findAll(page, limit) {
        return this.providersService.findAll(page, limit);
    }
    findById(id) {
        return this.providersService.findById(id);
    }
    verify(id) {
        return this.providersService.verify(id);
    }
};
exports.ProvidersController = ProvidersController;
__decorate([
    (0, common_1.Post)(),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_provider_dto_1.CreateProviderDto]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "create", null);
__decorate([
    (0, common_1.Get)('me'),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "getMyProfile", null);
__decorate([
    (0, common_1.Put)('me'),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_provider_dto_1.UpdateProviderDto]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "updateMyProfile", null);
__decorate([
    (0, common_1.Get)('me/stores'),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "getMyStores", null);
__decorate([
    (0, common_1.Get)('me/stores/:storeId'),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Param)('storeId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "getMyStoreById", null);
__decorate([
    (0, common_1.Get)(),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "findById", null);
__decorate([
    (0, common_1.Put)(':id/verify'),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ProvidersController.prototype, "verify", null);
exports.ProvidersController = ProvidersController = __decorate([
    (0, common_1.Controller)('providers'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    __metadata("design:paramtypes", [providers_service_1.ProvidersService])
], ProvidersController);
//# sourceMappingURL=providers.controller.js.map