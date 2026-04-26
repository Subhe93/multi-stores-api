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
exports.CalculateShippingDto = exports.EstimateShippingDto = exports.CreateShippingProfileDto = exports.CreateShippingZoneDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
class CreateShippingZoneDto {
    name;
    countries;
    base_cost;
    per_item_cost;
    free_threshold;
    estimated_days_min;
    estimated_days_max;
}
exports.CreateShippingZoneDto = CreateShippingZoneDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateShippingZoneDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], CreateShippingZoneDto.prototype, "countries", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateShippingZoneDto.prototype, "base_cost", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateShippingZoneDto.prototype, "per_item_cost", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateShippingZoneDto.prototype, "free_threshold", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateShippingZoneDto.prototype, "estimated_days_min", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateShippingZoneDto.prototype, "estimated_days_max", void 0);
class CreateShippingProfileDto {
    name;
    is_default;
    zones;
}
exports.CreateShippingProfileDto = CreateShippingProfileDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateShippingProfileDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateShippingProfileDto.prototype, "is_default", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CreateShippingZoneDto),
    __metadata("design:type", Array)
], CreateShippingProfileDto.prototype, "zones", void 0);
class EstimateShippingDto {
    product_ids;
    country_code;
    item_count;
    subtotal;
}
exports.EstimateShippingDto = EstimateShippingDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], EstimateShippingDto.prototype, "product_ids", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EstimateShippingDto.prototype, "country_code", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], EstimateShippingDto.prototype, "item_count", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], EstimateShippingDto.prototype, "subtotal", void 0);
class CalculateShippingDto {
    profile_id;
    country_code;
    item_count;
    subtotal;
}
exports.CalculateShippingDto = CalculateShippingDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CalculateShippingDto.prototype, "profile_id", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CalculateShippingDto.prototype, "country_code", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CalculateShippingDto.prototype, "item_count", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CalculateShippingDto.prototype, "subtotal", void 0);
//# sourceMappingURL=shipping.dto.js.map