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
exports.CreatorsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const creators_service_1 = require("./creators.service");
const create_creator_dto_1 = require("./dto/create-creator.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let CreatorsController = class CreatorsController {
    creatorsService;
    constructor(creatorsService) {
        this.creatorsService = creatorsService;
    }
    create(userId, dto) {
        return this.creatorsService.create(userId, dto);
    }
    getMyProfile(userId) {
        return this.creatorsService.findByUserId(userId);
    }
    updateMyProfile(userId, dto) {
        return this.creatorsService.update(userId, dto);
    }
    findAll(page, limit) {
        return this.creatorsService.findAll(page, limit);
    }
    findById(id) {
        return this.creatorsService.findById(id);
    }
    verify(id) {
        return this.creatorsService.verify(id);
    }
};
exports.CreatorsController = CreatorsController;
__decorate([
    (0, common_1.Post)(),
    (0, decorators_1.Roles)(client_1.UserRole.CREATOR),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_creator_dto_1.CreateCreatorDto]),
    __metadata("design:returntype", void 0)
], CreatorsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)('me'),
    (0, decorators_1.Roles)(client_1.UserRole.CREATOR),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CreatorsController.prototype, "getMyProfile", null);
__decorate([
    (0, common_1.Put)('me'),
    (0, decorators_1.Roles)(client_1.UserRole.CREATOR),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_creator_dto_1.UpdateCreatorDto]),
    __metadata("design:returntype", void 0)
], CreatorsController.prototype, "updateMyProfile", null);
__decorate([
    (0, common_1.Get)(),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number]),
    __metadata("design:returntype", void 0)
], CreatorsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CreatorsController.prototype, "findById", null);
__decorate([
    (0, common_1.Put)(':id/verify'),
    (0, decorators_1.Roles)(client_1.UserRole.ADMIN),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CreatorsController.prototype, "verify", null);
exports.CreatorsController = CreatorsController = __decorate([
    (0, common_1.Controller)('creators'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    __metadata("design:paramtypes", [creators_service_1.CreatorsService])
], CreatorsController);
//# sourceMappingURL=creators.controller.js.map