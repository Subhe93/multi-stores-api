import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
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
import { MenusModule } from './modules/menus/menus.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
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
    MenusModule,
    NotificationsModule,
    PaymentsModule,
  ],
})
export class AppModule {}
