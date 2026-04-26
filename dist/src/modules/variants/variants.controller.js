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
exports.VariantsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const variants_service_1 = require("./variants.service");
const variant_dto_1 = require("./dto/variant.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let VariantsController = class VariantsController {
    variantsService;
    constructor(variantsService) {
        this.variantsService = variantsService;
    }
    create(productId, dto) {
        return this.variantsService.create(productId, dto);
    }
    findByProduct(productId) {
        return this.variantsService.findByProduct(productId);
    }
    findById(id) {
        return this.variantsService.findById(id);
    }
    update(id, dto) {
        return this.variantsService.update(id, dto);
    }
    delete(id) {
        return this.variantsService.delete(id);
    }
    updateStock(id, quantity) {
        return this.variantsService.updateStock(id, quantity);
    }
};
exports.VariantsController = VariantsController;
__decorate([
    (0, common_1.Post)('products/:productId/variants'),
    __param(0, (0, common_1.Param)('productId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, variant_dto_1.CreateVariantDto]),
    __metadata("design:returntype", void 0)
], VariantsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)('products/:productId/variants'),
    __param(0, (0, common_1.Param)('productId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], VariantsController.prototype, "findByProduct", null);
__decorate([
    (0, common_1.Get)('variants/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], VariantsController.prototype, "findById", null);
__decorate([
    (0, common_1.Put)('variants/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, variant_dto_1.UpdateVariantDto]),
    __metadata("design:returntype", void 0)
], VariantsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)('variants/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], VariantsController.prototype, "delete", null);
__decorate([
    (0, common_1.Put)('variants/:id/stock'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)('quantity')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number]),
    __metadata("design:returntype", void 0)
], VariantsController.prototype, "updateStock", null);
exports.VariantsController = VariantsController = __decorate([
    (0, common_1.Controller)(),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __metadata("design:paramtypes", [variants_service_1.VariantsService])
], VariantsController);
//# sourceMappingURL=variants.controller.js.map