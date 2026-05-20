// Wipe all transactional data, keeping only the three seed users
// (admin/provider/creator) and platform-level reference data (categories,
// attribute templates, platform config). Run after stopping the API so no new
// rows are created mid-delete.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const KEEP_USER_IDS = [
  'a16e1b68-6789-420c-abd5-409e8ad9ea94', // admin@multistores.com
  'eaba18f7-db43-4e1d-857a-a844990b0f76', // provider@test.com
  'd6e2bbaf-1003-4257-b2b2-540e2bd6b2c7', // creator@test.com
];

async function step(label, fn) {
  process.stdout.write(`  • ${label} … `);
  const t0 = Date.now();
  const res = await fn();
  const count = typeof res?.count === 'number' ? res.count : 0;
  console.log(`${count} rows (${Date.now() - t0}ms)`);
}

(async () => {
  console.log('Resetting database, keeping users:');
  for (const id of KEEP_USER_IDS) console.log(`  - ${id}`);
  console.log('');

  try {
    // ── Orders & related ──
    await step('OrderTimeline', () => prisma.orderTimeline.deleteMany());
    await step('OrderCommission', () => prisma.orderCommission.deleteMany());
    await step('OrderCustomFieldValue', () => prisma.orderCustomFieldValue.deleteMany());
    await step('OrderItem', () => prisma.orderItem.deleteMany());
    await step('Order', () => prisma.order.deleteMany());

    // ── Carts ──
    await step('CartItem', () => prisma.cartItem.deleteMany());
    await step('Cart', () => prisma.cart.deleteMany());

    // ── Promotions ──
    await step('PromotionUsage', () => prisma.promotionUsage.deleteMany());
    await step('PromotionTranslation', () => prisma.promotionTranslation.deleteMany());
    await step('Promotion', () => prisma.promotion.deleteMany());

    // ── Bundles ──
    await step('BundleProduct', () => prisma.bundleProduct.deleteMany());
    await step('BundleCustomProduct', () => prisma.bundleCustomProduct.deleteMany());
    await step('BundleOfferTranslation', () => prisma.bundleOfferTranslation.deleteMany());
    await step('BundleOffer', () => prisma.bundleOffer.deleteMany());
    await step('BundleTranslation', () => prisma.bundleTranslation.deleteMany());
    await step('Bundle', () => prisma.bundle.deleteMany());

    // ── Custom Products ──
    await step('CustomProductImage', () => prisma.customProductImage.deleteMany());
    await step('CustomProductTranslation', () => prisma.customProductTranslation.deleteMany());
    await step('CustomProductVariant', () => prisma.customProductVariant.deleteMany());
    await step('CustomProductFieldValue', () => prisma.customProductFieldValue.deleteMany());
    await step('CustomProductFaqTranslation', () => prisma.customProductFaqTranslation.deleteMany());
    await step('CustomProductFaq', () => prisma.customProductFaq.deleteMany());
    await step('CustomProduct', () => prisma.customProduct.deleteMany());

    // ── Products & related (do FAQs/custom fields first as some have own translations) ──
    await step('CustomFieldTranslation', () => prisma.customFieldTranslation.deleteMany());
    await step('ProductCustomField', () => prisma.productCustomField.deleteMany());
    await step('ProductFaqTranslation', () => prisma.productFaqTranslation.deleteMany());
    await step('ProductFaq', () => prisma.productFaq.deleteMany());
    await step('ProductImage', () => prisma.productImage.deleteMany());
    await step('ProductVariant', () => prisma.productVariant.deleteMany());
    await step('ProductAttribute', () => prisma.productAttribute.deleteMany());
    await step('ProductTag', () => prisma.productTag.deleteMany());
    await step('ProductTranslation', () => prisma.productTranslation.deleteMany());
    await step('Product', () => prisma.product.deleteMany());

    // ── Stores & pages ──
    await step('PageBlockTranslation', () => prisma.pageBlockTranslation.deleteMany());
    await step('PageBlock', () => prisma.pageBlock.deleteMany());
    await step('StaticPageTranslation', () => prisma.staticPageTranslation.deleteMany());
    await step('StaticPage', () => prisma.staticPage.deleteMany());
    await step('StoreLanguageConfig', () => prisma.storeLanguageConfig.deleteMany());
    await step('Store', () => prisma.store.deleteMany());

    // ── Shipping ──
    await step('ShippingZone', () => prisma.shippingZone.deleteMany());
    await step('ShippingProfile', () => prisma.shippingProfile.deleteMany());

    // ── Customers & addresses ──
    await step('Address', () => prisma.address.deleteMany());
    await step('Customer', () => prisma.customer.deleteMany());

    // ── Notifications ──
    await step('Notification', () => prisma.notification.deleteMany());

    // ── Sessions for non-kept users ──
    await step('Session (others)', () =>
      prisma.session.deleteMany({ where: { user_id: { notIn: KEEP_USER_IDS } } }),
    );

    // ── Extra Provider/Creator records (kept users' records are protected by their user_id) ──
    await step('Provider (others)', () =>
      prisma.provider.deleteMany({ where: { user_id: { notIn: KEEP_USER_IDS } } }),
    );
    await step('Creator (others)', () =>
      prisma.creator.deleteMany({ where: { user_id: { notIn: KEEP_USER_IDS } } }),
    );

    // ── Finally: non-kept users ──
    await step('User (others)', () =>
      prisma.user.deleteMany({ where: { id: { notIn: KEEP_USER_IDS } } }),
    );

    console.log('\nDone. Summary:');
    const counts = {
      User: await prisma.user.count(),
      Provider: await prisma.provider.count(),
      Creator: await prisma.creator.count(),
      Customer: await prisma.customer.count(),
      Product: await prisma.product.count(),
      CustomProduct: await prisma.customProduct.count(),
      Store: await prisma.store.count(),
      Bundle: await prisma.bundle.count(),
      Order: await prisma.order.count(),
      Cart: await prisma.cart.count(),
      Category: await prisma.category.count(),
      AttributeTemplate: await prisma.attributeTemplate.count(),
    };
    console.table(counts);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
