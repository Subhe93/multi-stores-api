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
exports.TranslationsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const translations_service_1 = require("./translations.service");
const translation_dto_1 = require("./dto/translation.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
const class_validator_1 = require("class-validator");
class TranslateTextDto {
    text;
    source_locale;
    target_locale;
}
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TranslateTextDto.prototype, "text", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TranslateTextDto.prototype, "source_locale", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TranslateTextDto.prototype, "target_locale", void 0);
let TranslationsController = class TranslationsController {
    translationsService;
    constructor(translationsService) {
        this.translationsService = translationsService;
    }
    getOverview(req) {
        return this.translationsService.getOverview(req.user.id);
    }
    autoTranslate(dto) {
        return this.translationsService.autoTranslate(dto);
    }
    bulkTranslate(dto) {
        return this.translationsService.bulkTranslate(dto);
    }
    translateText(dto) {
        return this.translationsService.translateSingleText(dto.text, dto.source_locale, dto.target_locale);
    }
};
exports.TranslationsController = TranslationsController;
__decorate([
    (0, common_1.Get)('overview'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TranslationsController.prototype, "getOverview", null);
__decorate([
    (0, common_1.Post)('auto-translate'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [translation_dto_1.AutoTranslateDto]),
    __metadata("design:returntype", void 0)
], TranslationsController.prototype, "autoTranslate", null);
__decorate([
    (0, common_1.Post)('bulk-translate'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [translation_dto_1.BulkTranslateDto]),
    __metadata("design:returntype", void 0)
], TranslationsController.prototype, "bulkTranslate", null);
__decorate([
    (0, common_1.Post)('translate-text'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [TranslateTextDto]),
    __metadata("design:returntype", void 0)
], TranslationsController.prototype, "translateText", null);
exports.TranslationsController = TranslationsController = __decorate([
    (0, common_1.Controller)('translations'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.CREATOR, client_1.UserRole.ADMIN),
    __metadata("design:paramtypes", [translations_service_1.TranslationsService])
], TranslationsController);
//# sourceMappingURL=translations.controller.js.map