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
exports.UpdateAttributeTemplateDto = exports.AttributeTranslationDto = exports.CreateAttributeTemplateDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
class CreateAttributeTemplateDto {
    name;
    type;
    unit;
    options;
    is_required;
    group_name;
    validation_rules;
    sort_order;
    translations;
}
exports.CreateAttributeTemplateDto = CreateAttributeTemplateDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAttributeTemplateDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(client_1.AttributeType),
    __metadata("design:type", String)
], CreateAttributeTemplateDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAttributeTemplateDto.prototype, "unit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateAttributeTemplateDto.prototype, "options", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateAttributeTemplateDto.prototype, "is_required", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAttributeTemplateDto.prototype, "group_name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateAttributeTemplateDto.prototype, "validation_rules", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], CreateAttributeTemplateDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => AttributeTranslationDto),
    __metadata("design:type", Array)
], CreateAttributeTemplateDto.prototype, "translations", void 0);
class AttributeTranslationDto {
    locale;
    label;
    option_labels;
}
exports.AttributeTranslationDto = AttributeTranslationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AttributeTranslationDto.prototype, "locale", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], AttributeTranslationDto.prototype, "label", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], AttributeTranslationDto.prototype, "option_labels", void 0);
class UpdateAttributeTemplateDto {
    name;
    type;
    unit;
    options;
    is_required;
    group_name;
    validation_rules;
    sort_order;
    translations;
}
exports.UpdateAttributeTemplateDto = UpdateAttributeTemplateDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAttributeTemplateDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.AttributeType),
    __metadata("design:type", String)
], UpdateAttributeTemplateDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAttributeTemplateDto.prototype, "unit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], UpdateAttributeTemplateDto.prototype, "options", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateAttributeTemplateDto.prototype, "is_required", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAttributeTemplateDto.prototype, "group_name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], UpdateAttributeTemplateDto.prototype, "validation_rules", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], UpdateAttributeTemplateDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => AttributeTranslationDto),
    __metadata("design:type", Array)
], UpdateAttributeTemplateDto.prototype, "translations", void 0);
//# sourceMappingURL=attribute.dto.js.map