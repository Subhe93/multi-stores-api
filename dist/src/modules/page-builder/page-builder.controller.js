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
exports.PageBuilderController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const page_builder_service_1 = require("./page-builder.service");
const block_dto_1 = require("./dto/block.dto");
const decorators_1 = require("../../common/decorators");
const roles_guard_1 = require("../../common/guards/roles.guard");
const client_1 = require("@prisma/client");
let PageBuilderController = class PageBuilderController {
    pageBuilderService;
    constructor(pageBuilderService) {
        this.pageBuilderService = pageBuilderService;
    }
    getBlocks(pageId) {
        return this.pageBuilderService.getBlocks(pageId);
    }
    addBlock(pageId, dto) {
        return this.pageBuilderService.addBlock(pageId, dto);
    }
    updateBlock(id, dto) {
        return this.pageBuilderService.updateBlock(id, dto);
    }
    deleteBlock(id) {
        return this.pageBuilderService.deleteBlock(id);
    }
    reorderBlocks(pageId, blockIds) {
        return this.pageBuilderService.reorderBlocks(pageId, blockIds);
    }
};
exports.PageBuilderController = PageBuilderController;
__decorate([
    (0, common_1.Get)('pages/:pageId/blocks'),
    __param(0, (0, common_1.Param)('pageId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PageBuilderController.prototype, "getBlocks", null);
__decorate([
    (0, common_1.Post)('pages/:pageId/blocks'),
    __param(0, (0, common_1.Param)('pageId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, block_dto_1.CreateBlockDto]),
    __metadata("design:returntype", void 0)
], PageBuilderController.prototype, "addBlock", null);
__decorate([
    (0, common_1.Put)('blocks/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, block_dto_1.UpdateBlockDto]),
    __metadata("design:returntype", void 0)
], PageBuilderController.prototype, "updateBlock", null);
__decorate([
    (0, common_1.Delete)('blocks/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PageBuilderController.prototype, "deleteBlock", null);
__decorate([
    (0, common_1.Put)('pages/:pageId/blocks/sort'),
    __param(0, (0, common_1.Param)('pageId')),
    __param(1, (0, common_1.Body)('block_ids')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Array]),
    __metadata("design:returntype", void 0)
], PageBuilderController.prototype, "reorderBlocks", null);
exports.PageBuilderController = PageBuilderController = __decorate([
    (0, common_1.Controller)(),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), roles_guard_1.RolesGuard),
    (0, decorators_1.Roles)(client_1.UserRole.CREATOR),
    __metadata("design:paramtypes", [page_builder_service_1.PageBuilderService])
], PageBuilderController);
//# sourceMappingURL=page-builder.controller.js.map