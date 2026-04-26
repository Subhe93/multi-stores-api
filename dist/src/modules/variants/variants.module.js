"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VariantsModule = void 0;
const common_1 = require("@nestjs/common");
const variants_controller_1 = require("./variants.controller");
const variants_service_1 = require("./variants.service");
let VariantsModule = class VariantsModule {
};
exports.VariantsModule = VariantsModule;
exports.VariantsModule = VariantsModule = __decorate([
    (0, common_1.Module)({
        controllers: [variants_controller_1.VariantsController],
        providers: [variants_service_1.VariantsService],
        exports: [variants_service_1.VariantsService],
    })
], VariantsModule);
//# sourceMappingURL=variants.module.js.map