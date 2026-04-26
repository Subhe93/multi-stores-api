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
exports.UpdateBlockDto = exports.CreateBlockDto = exports.BlockTranslationDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
class BlockTranslationDto {
    locale;
    content;
}
exports.BlockTranslationDto = BlockTranslationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BlockTranslationDto.prototype, "locale", void 0);
class CreateBlockDto {
    type;
    settings;
    sort_order;
    translations;
}
exports.CreateBlockDto = CreateBlockDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.BlockType),
    __metadata("design:type", String)
], CreateBlockDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateBlockDto.prototype, "settings", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateBlockDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => BlockTranslationDto),
    __metadata("design:type", Array)
], CreateBlockDto.prototype, "translations", void 0);
class UpdateBlockDto {
    settings;
    sort_order;
    translations;
}
exports.UpdateBlockDto = UpdateBlockDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], UpdateBlockDto.prototype, "settings", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], UpdateBlockDto.prototype, "sort_order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => BlockTranslationDto),
    __metadata("design:type", Array)
], UpdateBlockDto.prototype, "translations", void 0);
//# sourceMappingURL=block.dto.js.map