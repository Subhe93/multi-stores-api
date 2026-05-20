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
exports.UpdateCustomProductDto = exports.CreateCustomProductDto = exports.CustomProductFieldValueDto = exports.CustomProductVariantDto = exports.CustomProductTranslationDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
class CustomProductTranslationDto {
    locale;
    title;
    description;
    slug;
}
exports.CustomProductTranslationDto = CustomProductTranslationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductTranslationDto.prototype, "locale", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductTranslationDto.prototype, "title", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductTranslationDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductTranslationDto.prototype, "slug", void 0);
class CustomProductVariantDto {
    variant_id;
    custom_price;
}
exports.CustomProductVariantDto = CustomProductVariantDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductVariantDto.prototype, "variant_id", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CustomProductVariantDto.prototype, "custom_price", void 0);
class CustomProductFieldValueDto {
    custom_field_id;
    value;
    file_url;
}
exports.CustomProductFieldValueDto = CustomProductFieldValueDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductFieldValueDto.prototype, "custom_field_id", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductFieldValueDto.prototype, "value", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomProductFieldValueDto.prototype, "file_url", void 0);
class CreateCustomProductDto {
    product_id;
    import_mode;
    pricing_type;
    final_price;
    margin_amount;
    selected_variants;
    field_values;
    mockup_image_urls;
    translations;
    bundle_ids;
    creator_category_ids;
}
exports.CreateCustomProductDto = CreateCustomProductDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCustomProductDto.prototype, "product_id", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(client_1.ImportMode),
    __metadata("design:type", String)
], CreateCustomProductDto.prototype, "import_mode", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(client_1.PricingType),
    __metadata("design:type", String)
], CreateCustomProductDto.prototype, "pricing_type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateCustomProductDto.prototype, "final_price", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateCustomProductDto.prototype, "margin_amount", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomProductVariantDto),
    __metadata("design:type", Array)
], CreateCustomProductDto.prototype, "selected_variants", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomProductFieldValueDto),
    __metadata("design:type", Array)
], CreateCustomProductDto.prototype, "field_values", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], CreateCustomProductDto.prototype, "mockup_image_urls", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomProductTranslationDto),
    __metadata("design:type", Array)
], CreateCustomProductDto.prototype, "translations", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], CreateCustomProductDto.prototype, "bundle_ids", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], CreateCustomProductDto.prototype, "creator_category_ids", void 0);
class UpdateCustomProductDto {
    pricing_type;
    final_price;
    margin_amount;
    status;
    selected_variants;
    field_values;
    mockup_image_urls;
    translations;
    bundle_ids;
    creator_category_ids;
}
exports.UpdateCustomProductDto = UpdateCustomProductDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.PricingType),
    __metadata("design:type", String)
], UpdateCustomProductDto.prototype, "pricing_type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], UpdateCustomProductDto.prototype, "final_price", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], UpdateCustomProductDto.prototype, "margin_amount", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.ProductStatus),
    __metadata("design:type", String)
], UpdateCustomProductDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomProductVariantDto),
    __metadata("design:type", Array)
], UpdateCustomProductDto.prototype, "selected_variants", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomProductFieldValueDto),
    __metadata("design:type", Array)
], UpdateCustomProductDto.prototype, "field_values", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], UpdateCustomProductDto.prototype, "mockup_image_urls", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomProductTranslationDto),
    __metadata("design:type", Array)
], UpdateCustomProductDto.prototype, "translations", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], UpdateCustomProductDto.prototype, "bundle_ids", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], UpdateCustomProductDto.prototype, "creator_category_ids", void 0);
//# sourceMappingURL=custom-product.dto.js.map