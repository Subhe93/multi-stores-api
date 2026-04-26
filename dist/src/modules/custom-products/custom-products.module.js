"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomProductsModule = void 0;
const common_1 = require("@nestjs/common");
const custom_products_controller_1 = require("./custom-products.controller");
const custom_products_service_1 = require("./custom-products.service");
const notifications_module_1 = require("../notifications/notifications.module");
let CustomProductsModule = class CustomProductsModule {
};
exports.CustomProductsModule = CustomProductsModule;
exports.CustomProductsModule = CustomProductsModule = __decorate([
    (0, common_1.Module)({
        imports: [notifications_module_1.NotificationsModule],
        controllers: [custom_products_controller_1.CustomProductsController],
        providers: [custom_products_service_1.CustomProductsService],
        exports: [custom_products_service_1.CustomProductsService],
    })
], CustomProductsModule);
//# sourceMappingURL=custom-products.module.js.map