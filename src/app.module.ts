import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { RevalidationModule } from './common/revalidation/revalidation.module';
import { CorsModule } from './common/cors/cors.module';
import { StoreAppsModule } from './modules/store-apps/store-apps.module';
import { MarketsModule } from './modules/markets/markets.module';
import { RedirectsModule } from './modules/redirects/redirects.module';
import { ImporterModule } from './modules/importer/importer.module';
import { OccasionConversionModule } from './modules/occasion-conversion/occasion-conversion.module';
import { B2bModule } from './modules/b2b/b2b.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { CreatorsModule } from './modules/creators/creators.module';
import { CustomersModule } from './modules/customers/customers.module';
import { UsersModule } from './modules/users/users.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CreatorCategoriesModule } from './modules/creator-categories/creator-categories.module';
import { AttributesModule } from './modules/attributes/attributes.module';
import { ProductsModule } from './modules/products/products.module';
import { VariantsModule } from './modules/variants/variants.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { CartModule } from './modules/cart/cart.module';
import { OrdersModule } from './modules/orders/orders.module';
import { TaxesModule } from './modules/taxes/taxes.module';
import { CommissionsModule } from './modules/commissions/commissions.module';
import { StoresModule } from './modules/stores/stores.module';
import { StorefrontModule } from './modules/storefront/storefront.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { CustomProductsModule } from './modules/custom-products/custom-products.module';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module';
import { ProductFaqsModule } from './modules/product-faqs/product-faqs.module';
import { PromotionsModule } from './modules/promotions/promotions.module';
import { BundlesModule } from './modules/bundles/bundles.module';
import { TranslationsModule } from './modules/translations/translations.module';
import { PagesModule } from './modules/pages/pages.module';
import { PageBuilderModule } from './modules/page-builder/page-builder.module';
import { PagesV2Module } from './modules/pages-v2/pages-v2.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { ThemesModule } from './modules/themes/themes.module';
import { MenusModule } from './modules/menus/menus.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { MailModule } from './modules/mail/mail.module';
import { LegalModule } from './modules/legal/legal.module';
import { NotificationTemplatesModule } from './modules/notification-templates/notification-templates.module';
import { BackupsModule } from './modules/backups/backups.module';
import { PrivateStorageModule } from './common/storage/private-storage.module';
import { RetentionModule } from './modules/retention/retention.module';
import { CustomerUploadsModule } from './modules/customer-uploads/customer-uploads.module';
import { ProductionModule } from './modules/production/production.module';
import { DesignerModule } from './modules/designer/designer.module';
import { OpsModule } from './modules/ops/ops.module';
import { FeedsModule } from './modules/feeds/feeds.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Generous global backstop against runaway clients. It is deliberately not
    // the real defence — sensitive routes carry their own tight @Throttle, and
    // storefront reads / Stripe webhooks are exempt (both legitimately arrive
    // in bursts from a single IP).
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    PrismaModule,
    CryptoModule,
    RevalidationModule,
    StoreAppsModule,
    MarketsModule,
    RedirectsModule,
    B2bModule,
    InvoicesModule,
    CorsModule,
    AuthModule,
    UsersModule,
    ProvidersModule,
    CreatorsModule,
    CustomersModule,
    CategoriesModule,
    CreatorCategoriesModule,
    AttributesModule,
    ProductsModule,
    VariantsModule,
    ShippingModule,
    CartModule,
    OrdersModule,
    TaxesModule,
    CommissionsModule,
    StoresModule,
    StorefrontModule,
    UploadsModule,
    CustomProductsModule,
    CustomFieldsModule,
    ProductFaqsModule,
    PromotionsModule,
    BundlesModule,
    TranslationsModule,
    PagesModule,
    PageBuilderModule,
    PagesV2Module,
    TemplatesModule,
    ThemesModule,
    MenusModule,
    NotificationsModule,
    PaymentsModule,
    MailModule,
    LegalModule,
    NotificationTemplatesModule,
    BackupsModule,
    PrivateStorageModule,
    RetentionModule,
    CustomerUploadsModule,
    // M4.3 production app: routes + status automation (the core module is
    // imported by OrdersModule).
    ProductionModule,
    // M4.4 importer app (worker off with IMPORTER_WORKER=off).
    ImporterModule,
    // Namez go-live Phase 1: sub-collections → root occasion pages (admin only).
    OccasionConversionModule,
    // M4.2 designer app (P3: storage, template assets, fonts, signed links).
    DesignerModule,
    // M5 W1-C operability: /admin/ops/status, job tick sink, WORKERS switch.
    OpsModule,
    // M5.6 feeds app: Google Merchant / Meta catalog feeds (public token URLs).
    FeedsModule,
  ],
  providers: [
    // ThrottlerModule alone throttles nothing — only routes that explicitly
    // used ThrottlerGuard were covered, leaving login, register, coupon
    // validation and checkout open to brute force and cost abuse.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
