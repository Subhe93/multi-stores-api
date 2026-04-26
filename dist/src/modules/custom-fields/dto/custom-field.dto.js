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
exports.UpdateCustomFieldDto = exports.CreateCustomFieldDto = exports.CustomFieldTranslationDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
class CustomFieldTranslationDto {
    locale;
    label;
    placeholder;
    option_labels;
}
exports.CustomFieldTranslationDto = CustomFieldTranslationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFieldTranslationDto.prototype, "locale", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFieldTranslationDto.prototype, "label", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFieldTranslationDto.prototype, "placeholder", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CustomFieldTranslationDto.prototype, "option_labels", void 0);
class CreateCustomFieldDto {
    name;
    type;
    is_required;
    placeholder;
    options;
    validation_rules;
    linked_validation;
    sort_order;
    translations;
}
exports.CreateCustomFieldDto = CreateCustomFieldDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCustomFieldDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomFieldType),
    __metadata("design:type", String)
], CreateCustomFieldDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateCustomFieldDto.prototype, "is_required", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCustomFieldDto.prototype, "placeholder", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateCustomFieldDto.prototype, "options", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateCustomFieldDto.prototype, "validation_rules", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateCustomFieldDto.prototype, "linked_validation", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateCustomFieldDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomFieldTranslationDto),
    __metadata("design:type", Array)
], CreateCustomFieldDto.prototype, "translations", void 0);
class UpdateCustomFieldDto {
    name;
    type;
    is_required;
    placeholder;
    options;
    validation_rules;
    linked_validation;
    sort_order;
    translations;
}
exports.UpdateCustomFieldDto = UpdateCustomFieldDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateCustomFieldDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomFieldType),
    __metadata("design:type", String)
], UpdateCustomFieldDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateCustomFieldDto.prototype, "is_required", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateCustomFieldDto.prototype, "placeholder", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], UpdateCustomFieldDto.prototype, "options", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], UpdateCustomFieldDto.prototype, "validation_rules", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], UpdateCustomFieldDto.prototype, "linked_validation", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], UpdateCustomFieldDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CustomFieldTranslationDto),
    __metadata("design:type", Array)
], UpdateCustomFieldDto.prototype, "translations", void 0);
//# sourceMappingURL=custom-field.dto.js.map