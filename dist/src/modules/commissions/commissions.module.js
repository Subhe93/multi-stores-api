"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommissionsModule = void 0;
const common_1 = require("@nestjs/common");
const commissions_controller_1 = require("./commissions.controller");
const commissions_service_1 = require("./commissions.service");
let CommissionsModule = class CommissionsModule {
};
exports.CommissionsModule = CommissionsModule;
exports.CommissionsModule = CommissionsModule = __decorate([
    (0, common_1.Module)({
        controllers: [commissions_controller_1.CommissionsController],
        providers: [commissions_service_1.CommissionsService],
        exports: [commissions_service_1.CommissionsService],
    })
], CommissionsModule);
//# sourceMappingURL=commissions.module.js.map