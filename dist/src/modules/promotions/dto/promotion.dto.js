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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidateCouponDto = exports.UpdatePromotionDto = exports.CreatePromotionDto = exports.PromotionTranslationDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
class PromotionTranslationDto {
    locale;
    title;
    description;
}
exports.PromotionTranslationDto = PromotionTranslationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], PromotionTranslationDto.prototype, "locale", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], PromotionTranslationDto.prototype, "title", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], PromotionTranslationDto.prototype, "description", void 0);
class CreatePromotionDto {
    type;
    level;
    value;
    conditions;
    coupon_code;
    usage_limit;
    starts_at;
    expires_at;
    translations;
}
exports.CreatePromotionDto = CreatePromotionDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.PromotionType),
    __metadata("design:type", String)
], CreatePromotionDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(client_1.PromotionLevel),
    __metadata("design:type", String)
], CreatePromotionDto.prototype, "level", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreatePromotionDto.prototype, "value", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreatePromotionDto.prototype, "conditions", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreatePromotionDto.prototype, "coupon_code", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreatePromotionDto.prototype, "usage_limit", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreatePromotionDto.prototype, "starts_at", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreatePromotionDto.prototype, "expires_at", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => PromotionTranslationDto),
    __metadata("design:type", Array)
], CreatePromotionDto.prototype, "translations", void 0);
class UpdatePromotionDto {
    value;
    conditions;
    usage_limit;
    expires_at;
    status;
    translations;
}
exports.UpdatePromotionDto = UpdatePromotionDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], UpdatePromotionDto.prototype, "value", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], UpdatePromotionDto.prototype, "conditions", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], UpdatePromotionDto.prototype, "usage_limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], UpdatePromotionDto.prototype, "expires_at", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.PromotionStatus),
    __metadata("design:type", String)
], UpdatePromotionDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => PromotionTranslationDto),
    __metadata("design:type", Array)
], UpdatePromotionDto.prototype, "translations", void 0);
class ValidateCouponDto {
    coupon_code;
    subtotal;
    item_count;
    product_ids;
}
exports.ValidateCouponDto = ValidateCouponDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ValidateCouponDto.prototype, "coupon_code", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], ValidateCouponDto.prototype, "subtotal", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], ValidateCouponDto.prototype, "item_count", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], ValidateCouponDto.prototype, "product_ids", void 0);
//# sourceMappingURL=promotion.dto.js.map