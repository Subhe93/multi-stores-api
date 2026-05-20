"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const throttler_1 = require("@nestjs/throttler");
const prisma_module_1 = require("./prisma/prisma.module");
const revalidation_module_1 = require("./common/revalidation/revalidation.module");
const auth_module_1 = require("./modules/auth/auth.module");
const providers_module_1 = require("./modules/providers/providers.module");
const creators_module_1 = require("./modules/creators/creators.module");
const customers_module_1 = require("./modules/customers/customers.module");
const users_module_1 = require("./modules/users/users.module");
const categories_module_1 = require("./modules/categories/categories.module");
const creator_categories_module_1 = require("./modules/creator-categories/creator-categories.module");
const attributes_module_1 = require("./modules/attributes/attributes.module");
const products_module_1 = require("./modules/products/products.module");
const variants_module_1 = require("./modules/variants/variants.module");
const shipping_module_1 = require("./modules/shipping/shipping.module");
const cart_module_1 = require("./modules/cart/cart.module");
const orders_module_1 = require("./modules/orders/orders.module");
const commissions_module_1 = require("./modules/commissions/commissions.module");
const stores_module_1 = require("./modules/stores/stores.module");
const storefront_module_1 = require("./modules/storefront/storefront.module");
const uploads_module_1 = require("./modules/uploads/uploads.module");
const custom_products_module_1 = require("./modules/custom-products/custom-products.module");
const custom_fields_module_1 = require("./modules/custom-fields/custom-fields.module");
const product_faqs_module_1 = require("./modules/product-faqs/product-faqs.module");
const promotions_module_1 = require("./modules/promotions/promotions.module");
const bundles_module_1 = require("./modules/bundles/bundles.module");
const translations_module_1 = require("./modules/translations/translations.module");
const pages_module_1 = require("./modules/pages/pages.module");
const page_builder_module_1 = require("./modules/page-builder/page-builder.module");
const pages_v2_module_1 = require("./modules/pages-v2/pages-v2.module");
const templates_module_1 = require("./modules/templates/templates.module");
const menus_module_1 = require("./modules/menus/menus.module");
const notifications_module_1 = require("./modules/notifications/notifications.module");
const payments_module_1 = require("./modules/payments/payments.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            throttler_1.ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
            prisma_module_1.PrismaModule,
            revalidation_module_1.RevalidationModule,
            auth_module_1.AuthModule,
            users_module_1.UsersModule,
            providers_module_1.ProvidersModule,
            creators_module_1.CreatorsModule,
            customers_module_1.CustomersModule,
            categories_module_1.CategoriesModule,
            creator_categories_module_1.CreatorCategoriesModule,
            attributes_module_1.AttributesModule,
            products_module_1.ProductsModule,
            variants_module_1.VariantsModule,
            shipping_module_1.ShippingModule,
            cart_module_1.CartModule,
            orders_module_1.OrdersModule,
            commissions_module_1.CommissionsModule,
            stores_module_1.StoresModule,
            storefront_module_1.StorefrontModule,
            uploads_module_1.UploadsModule,
            custom_products_module_1.CustomProductsModule,
            custom_fields_module_1.CustomFieldsModule,
            product_faqs_module_1.ProductFaqsModule,
            promotions_module_1.PromotionsModule,
            bundles_module_1.BundlesModule,
            translations_module_1.TranslationsModule,
            pages_module_1.PagesModule,
            page_builder_module_1.PageBuilderModule,
            pages_v2_module_1.PagesV2Module,
            templates_module_1.TemplatesModule,
            menus_module_1.MenusModule,
            notifications_module_1.NotificationsModule,
            payments_module_1.PaymentsModule,
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map