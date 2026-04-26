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
exports.CustomProductsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const custom_products_service_1 = require("./custom-products.service");
const custom_product_dto_1 = require("./dto/custom-product.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
class FaqTranslationDto {
    locale;
    question;
    answer;
}
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], FaqTranslationDto.prototype, "locale", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], FaqTranslationDto.prototype, "question", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], FaqTranslationDto.prototype, "answer", void 0);
class CreateCustomProductFaqDto {
    sort_order;
    translations;
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateCustomProductFaqDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => FaqTranslationDto),
    __metadata("design:type", Array)
], CreateCustomProductFaqDto.prototype, "translations", void 0);
class UpdateCustomProductFaqDto {
    sort_order;
    translations;
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], UpdateCustomProductFaqDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => FaqTranslationDto),
    __metadata("design:type", Array)
], UpdateCustomProductFaqDto.prototype, "translations", void 0);
class RejectCustomProductDto {
    reason;
}
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], RejectCustomProductDto.prototype, "reason", void 0);
let CustomProductsController = class CustomProductsController {
    customProductsService;
    constructor(customProductsService) {
        this.customProductsService = customProductsService;
    }
    create(userId, dto) {
        return this.customProductsService.create(userId, dto);
    }
    findMyCustomProducts(userId, page, limit) {
        return this.customProductsService.findByCreator(userId, page ? +page : undefined, limit ? +limit : undefined);
    }
    pendingReviews(userId, page, limit) {
        return this.customProductsService.findPendingReviewsForProvider(userId, page ? +page : undefined, limit ? +limit : undefined);
    }
    findById(id) {
        return this.customProductsService.findById(id);
    }
    update(id, dto, userId) {
        return this.customProductsService.update(id, dto, userId);
    }
    delete(id, userId) {
        return this.customProductsService.delete(id, userId);
    }
    submit(id, userId) {
        return this.customProductsService.submitForReview(id, userId);
    }
    approve(id, userId) {
        return this.customProductsService.approve(id, userId);
    }
    reject(id, userId, dto) {
        return this.customProductsService.reject(id, userId, dto.reason);
    }
    listFaqs(id) {
        return this.customProductsService.findFaqs(id);
    }
    createFaq(id, dto) {
        return this.customProductsService.createFaq(id, dto);
    }
    updateFaq(faqId, dto) {
        return this.customProductsService.updateFaq(faqId, dto);
    }
    deleteFaq(faqId) {
        return this.customProductsService.deleteFaq(faqId);
    }
};
exports.CustomProductsController = CustomProductsController;
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, custom_product_dto_1.CreateCustomProductDto]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "findMyCustomProducts", null);
__decorate([
    (0, common_1.Get)('pending-reviews'),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    __param(0, (0, decorators_1.CurrentUser)('id')),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "pendingReviews", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, decorators_1.Roles)(client_1.UserRole.CREATOR, client_1.UserRole.PROVIDER),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "findById", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, custom_product_dto_1.UpdateCustomProductDto, String]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "delete", null);
__decorate([
    (0, common_1.Post)(':id/submit'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "submit", null);
__decorate([
    (0, common_1.Post)(':id/approve'),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "approve", null);
__decorate([
    (0, common_1.Post)(':id/reject'),
    (0, decorators_1.Roles)(client_1.UserRole.PROVIDER),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, decorators_1.CurrentUser)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, RejectCustomProductDto]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "reject", null);
__decorate([
    (0, common_1.Get)(':id/faqs'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "listFaqs", null);
__decorate([
    (0, common_1.Post)(':id/faqs'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CreateCustomProductFaqDto]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "createFaq", null);
__decorate([
    (0, common_1.Put)('faqs/:faqId'),
    __param(0, (0, common_1.Param)('faqId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateCustomProductFaqDto]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "updateFaq", null);
__decorate([
    (0, common_1.Delete)('faqs/:faqId'),
    __param(0, (0, common_1.Param)('faqId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CustomProductsController.prototype, "deleteFaq", null);
exports.CustomProductsController = CustomProductsController = __decorate([
    (0, common_1.Controller)('custom-products'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.CREATOR),
    __metadata("design:paramtypes", [custom_products_service_1.CustomProductsService])
], CustomProductsController);
//# sourceMappingURL=custom-products.controller.js.map