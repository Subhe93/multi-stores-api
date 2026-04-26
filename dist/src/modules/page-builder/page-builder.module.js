"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PageBuilderModule = void 0;
const common_1 = require("@nestjs/common");
const page_builder_controller_1 = require("./page-builder.controller");
const page_builder_service_1 = require("./page-builder.service");
let PageBuilderModule = class PageBuilderModule {
};
exports.PageBuilderModule = PageBuilderModule;
exports.PageBuilderModule = PageBuilderModule = __decorate([
    (0, common_1.Module)({
        controllers: [page_builder_controller_1.PageBuilderController],
        providers: [page_builder_service_1.PageBuilderService],
        exports: [page_builder_service_1.PageBuilderService],
    })
], PageBuilderModule);
//# sourceMappingURL=page-builder.module.js.map