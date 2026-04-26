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
exports.ProductFaqsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const product_faqs_service_1 = require("./product-faqs.service");
const product_faq_dto_1 = require("./dto/product-faq.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let ProductFaqsController = class ProductFaqsController {
    faqsService;
    constructor(faqsService) {
        this.faqsService = faqsService;
    }
    create(productId, dto) {
        return this.faqsService.create(productId, dto);
    }
    findByProduct(productId) {
        return this.faqsService.findByProduct(productId);
    }
    update(id, dto) {
        return this.faqsService.update(id, dto);
    }
    delete(id) {
        return this.faqsService.delete(id);
    }
    reorder(productId, faqIds) {
        return this.faqsService.reorder(productId, faqIds);
    }
};
exports.ProductFaqsController = ProductFaqsController;
__decorate([
    (0, common_1.Post)('products/:productId/faqs'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('productId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, product_faq_dto_1.CreateProductFaqDto]),
    __metadata("design:returntype", void 0)
], ProductFaqsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)('products/:productId/faqs'),
    __param(0, (0, common_1.Param)('productId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ProductFaqsController.prototype, "findByProduct", null);
__decorate([
    (0, common_1.Put)('faqs/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, product_faq_dto_1.UpdateProductFaqDto]),
    __metadata("design:returntype", void 0)
], ProductFaqsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)('faqs/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ProductFaqsController.prototype, "delete", null);
__decorate([
    (0, common_1.Put)('products/:productId/faqs/sort'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER, client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('productId')),
    __param(1, (0, common_1.Body)('faq_ids')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Array]),
    __metadata("design:returntype", void 0)
], ProductFaqsController.prototype, "reorder", null);
exports.ProductFaqsController = ProductFaqsController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [product_faqs_service_1.ProductFaqsService])
], ProductFaqsController);
//# sourceMappingURL=product-faqs.controller.js.map