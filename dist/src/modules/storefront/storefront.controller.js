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
exports.StorefrontController = void 0;
const common_1 = require("@nestjs/common");
const storefront_service_1 = require("./storefront.service");
let StorefrontController = class StorefrontController {
    storefrontService;
    constructor(storefrontService) {
        this.storefrontService = storefrontService;
    }
    getStore(slug) {
        return this.storefrontService.getStore(slug);
    }
    getProducts(slug, page, limit, category_id, creator_category, search, locale) {
        return this.storefrontService.getProducts(slug, {
            page: page ? +page : undefined,
            limit: limit ? +limit : undefined,
            category_id,
            creator_category,
            search,
            locale,
        });
    }
    getProduct(slug, productSlug, locale) {
        return this.storefrontService.getProduct(slug, productSlug, locale);
    }
    getCategories(slug) {
        return this.storefrontService.getCategories(slug);
    }
    getCreatorCategories(slug) {
        return this.storefrontService.getCreatorCategories(slug);
    }
    getMenus(slug) {
        return this.storefrontService.getMenus(slug);
    }
    getPage(slug, pageSlug) {
        return this.storefrontService.getPage(slug, pageSlug);
    }
    getHome(slug) {
        return this.storefrontService.getPublishedPage(slug, { type: 'HOME' });
    }
    getProductTemplate(slug) {
        return this.storefrontService.getPublishedPage(slug, { type: 'PRODUCT_TEMPLATE' });
    }
    getHeader(slug) {
        return this.storefrontService.getPublishedPage(slug, { type: 'HEADER' });
    }
    getFooter(slug) {
        return this.storefrontService.getPublishedPage(slug, { type: 'FOOTER' });
    }
    getSampleProduct(slug) {
        return this.storefrontService.getSampleProduct(slug);
    }
    getPublishedPage(slug, pageSlug, type) {
        return this.storefrontService.getPublishedPage(slug, {
            type: type ?? 'STATIC',
            slug: pageSlug,
        });
    }
    getSitemapData(slug) {
        return this.storefrontService.getSitemapData(slug);
    }
};
exports.StorefrontController = StorefrontController;
__decorate([
    (0, common_1.Get)(':slug'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getStore", null);
__decorate([
    (0, common_1.Get)(':slug/products'),
    __param(0, (0, common_1.Param)('slug')),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __param(3, (0, common_1.Query)('category_id')),
    __param(4, (0, common_1.Query)('creator_category')),
    __param(5, (0, common_1.Query)('search')),
    __param(6, (0, common_1.Query)('locale')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number, String, String, String, String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getProducts", null);
__decorate([
    (0, common_1.Get)(':slug/products/:productSlug'),
    __param(0, (0, common_1.Param)('slug')),
    __param(1, (0, common_1.Param)('productSlug')),
    __param(2, (0, common_1.Query)('locale')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getProduct", null);
__decorate([
    (0, common_1.Get)(':slug/categories'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getCategories", null);
__decorate([
    (0, common_1.Get)(':slug/creator-categories'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getCreatorCategories", null);
__decorate([
    (0, common_1.Get)(':slug/menus'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getMenus", null);
__decorate([
    (0, common_1.Get)(':slug/pages/:pageSlug'),
    __param(0, (0, common_1.Param)('slug')),
    __param(1, (0, common_1.Param)('pageSlug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getPage", null);
__decorate([
    (0, common_1.Get)(':slug/v2/home'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getHome", null);
__decorate([
    (0, common_1.Get)(':slug/v2/product-template'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getProductTemplate", null);
__decorate([
    (0, common_1.Get)(':slug/v2/header'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getHeader", null);
__decorate([
    (0, common_1.Get)(':slug/v2/footer'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getFooter", null);
__decorate([
    (0, common_1.Get)(':slug/v2/sample-product'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getSampleProduct", null);
__decorate([
    (0, common_1.Get)(':slug/v2/pages/:pageSlug'),
    __param(0, (0, common_1.Param)('slug')),
    __param(1, (0, common_1.Param)('pageSlug')),
    __param(2, (0, common_1.Query)('type')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getPublishedPage", null);
__decorate([
    (0, common_1.Get)(':slug/sitemap-data'),
    __param(0, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StorefrontController.prototype, "getSitemapData", null);
exports.StorefrontController = StorefrontController = __decorate([
    (0, common_1.Controller)('storefront'),
    __metadata("design:paramtypes", [storefront_service_1.StorefrontService])
], StorefrontController);
//# sourceMappingURL=storefront.controller.js.map