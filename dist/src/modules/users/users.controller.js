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
exports.UsersController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const users_service_1 = require("./users.service");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let UsersController = class UsersController {
    usersService;
    constructor(usersService) {
        this.usersService = usersService;
    }
    findAll(page, limit, role, status, search) {
        return this.usersService.findAll(page ? +page : undefined, limit ? +limit : undefined, { role, status, search });
    }
    getDashboardStats() {
        return this.usersService.getDashboardStats();
    }
    getRecentUsers() {
        return this.usersService.getRecentUsers();
    }
    findById(id) {
        return this.usersService.findById(id);
    }
    updateStatus(id, status) {
        return this.usersService.updateStatus(id, status);
    }
    getPlatformConfig() {
        return this.usersService.getPlatformConfig();
    }
    updatePlatformConfig(body) {
        return this.usersService.updatePlatformConfig(body);
    }
};
exports.UsersController = UsersController;
__decorate([
    (0, common_1.Get)('users'),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('role')),
    __param(3, (0, common_1.Query)('status')),
    __param(4, (0, common_1.Query)('search')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, String, String, String]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('users/stats'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "getDashboardStats", null);
__decorate([
    (0, common_1.Get)('users/recent'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "getRecentUsers", null);
__decorate([
    (0, common_1.Get)('users/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "findById", null);
__decorate([
    (0, common_1.Put)('users/:id/status'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)('status')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "updateStatus", null);
__decorate([
    (0, common_1.Get)('platform-config'),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN, client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "getPlatformConfig", null);
__decorate([
    (0, common_1.Put)('platform-config'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], UsersController.prototype, "updatePlatformConfig", null);
exports.UsersController = UsersController = __decorate([
    (0, common_1.Controller)('admin'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN),
    __metadata("design:paramtypes", [users_service_1.UsersService])
], UsersController);
//# sourceMappingURL=users.controller.js.map