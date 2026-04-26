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
exports.CustomFieldsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const custom_fields_service_1 = require("./custom-fields.service");
const custom_field_dto_1 = require("./dto/custom-field.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let CustomFieldsController = class CustomFieldsController {
    customFieldsService;
    constructor(customFieldsService) {
        this.customFieldsService = customFieldsService;
    }
    create(productId, dto) {
        return this.customFieldsService.create(productId, dto);
    }
    findByProduct(productId) {
        return this.customFieldsService.findByProduct(productId);
    }
    update(id, dto) {
        return this.customFieldsService.update(id, dto);
    }
    delete(id) {
        return this.customFieldsService.delete(id);
    }
    reorder(productId, fieldIds) {
        return this.customFieldsService.reorder(productId, fieldIds);
    }
};
exports.CustomFieldsController = CustomFieldsController;
__decorate([
    (0, common_1.Post)('products/:productId/custom-fields'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('productId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, custom_field_dto_1.CreateCustomFieldDto]),
    __metadata("design:returntype", void 0)
], CustomFieldsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)('products/:productId/custom-fields'),
    __param(0, (0, common_1.Param)('productId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CustomFieldsController.prototype, "findByProduct", null);
__decorate([
    (0, common_1.Put)('custom-fields/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, custom_field_dto_1.UpdateCustomFieldDto]),
    __metadata("design:returntype", void 0)
], CustomFieldsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)('custom-fields/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CustomFieldsController.prototype, "delete", null);
__decorate([
    (0, common_1.Put)('products/:productId/custom-fields/sort'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR),
    __param(0, (0, common_1.Param)('productId')),
    __param(1, (0, common_1.Body)('field_ids')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Array]),
    __metadata("design:returntype", void 0)
], CustomFieldsController.prototype, "reorder", null);
exports.CustomFieldsController = CustomFieldsController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [custom_fields_service_1.CustomFieldsService])
], CustomFieldsController);
//# sourceMappingURL=custom-fields.controller.js.map