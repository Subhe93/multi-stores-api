import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  buildPlatformEmailTemplates,
  toTemplateColumns,
} from './platform-email-templates';

const prisma = new PrismaClient();

/**
 * Staff accounts (store_id NULL) are unique by email through a partial index
 * Prisma cannot address in upsert(), so find-or-create instead.
 */
async function upsertStaff(data: Prisma.UserCreateInput) {
  const existing = await prisma.user.findFirst({
    where: { email: data.email, store_id: null },
  });
  // Seeded staff are verified: the onboarding guard / checklist never
  // locks a dev account.
  return (
    existing ??
    prisma.user.create({ data: { email_verified_at: new Date(), ...data } })
  );
}

async function main() {
  console.log('Seeding database...');

  // Admin user
  const adminPassword = await bcrypt.hash('admin123456', 12);
  const admin = await upsertStaff({
    email: 'admin@multistores.com',
    password_hash: adminPassword,
    role: UserRole.ADMIN,
    status: 'ACTIVE',
  });
  console.log('Admin created:', admin.email);

  // Test Provider
  const providerPassword = await bcrypt.hash('provider123', 12);
  const providerUser = await upsertStaff({
    email: 'provider@test.com',
    password_hash: providerPassword,
    role: UserRole.PROVIDER,
    status: 'ACTIVE',
    provider: {
      create: {
        company_name: 'Test Manufacturing Co.',
        description: 'Premium handmade products',
        country: 'DE',
        verified: true,
      },
    },
  });
  console.log('Provider created:', providerUser.email);

  // Test Creator
  const creatorPassword = await bcrypt.hash('creator123', 12);
  const creatorUser = await upsertStaff({
    email: 'creator@test.com',
    password_hash: creatorPassword,
    role: UserRole.CREATOR,
    status: 'ACTIVE',
    creator: {
      create: {
        display_name: 'Ahmed Design',
        bio: 'Creative designer specializing in custom products',
        verified: true,
      },
    },
  });
  console.log('Creator created:', creatorUser.email);

  // Create Store for Creator
  const creator = await prisma.creator.findUnique({ where: { user_id: creatorUser.id } });
  let seededStoreId: string | null = null;
  if (creator) {
    const store = await prisma.store.upsert({
      where: { creator_id: creator.id },
      update: {},
      create: {
        creator_id: creator.id,
        name: 'Ahmed Design Store',
        slug: 'ahmed-design',
        description: 'Custom designed products by Ahmed',
        // is_active is derived from status (LIVE) — keep both in step.
        status: 'LIVE',
        is_active: true,
        language_config: {
          create: {
            primary_locale: 'en',
            secondary_locales: ['ar'],
            auto_translate: true,
          },
        },
      },
    });
    seededStoreId = store.id;
    console.log('Store created for creator');
  }
  if (!seededStoreId) throw new Error('Seed store missing');

  // Test Customer
  const customerPassword = await bcrypt.hash('customer123', 12);
  // Customer accounts belong to one store: the demo customer is a customer
  // of the seeded store and logs in on that storefront only.
  const customerUser = await prisma.user.upsert({
    where: {
      store_id_email: { store_id: seededStoreId, email: 'customer@test.com' },
    },
    update: {},
    create: {
      email: 'customer@test.com',
      password_hash: customerPassword,
      role: UserRole.CUSTOMER,
      status: 'ACTIVE',
      store: { connect: { id: seededStoreId } },
      customer: {
        create: {
          first_name: 'Sara',
          last_name: 'Ahmad',
          phone: '+49123456789',
          addresses: {
            create: {
              label: 'Home',
              full_name: 'Sara Ahmad',
              line1: 'Berliner Str. 123',
              city: 'Berlin',
              state: 'Berlin',
              postal_code: '10115',
              country_code: 'DE',
              is_default: true,
            },
          },
        },
      },
    },
  });
  console.log('Customer created:', customerUser.email);

  // ======================
  // Attribute Templates
  // ======================
  const fabric = await prisma.attributeTemplate.upsert({
    where: { id: 'attr-fabric' },
    update: {},
    create: {
      id: 'attr-fabric',
      name: 'fabric',
      type: 'SELECT',
      options: ['cotton', 'polyester', 'blend', 'silk', 'linen'],
      is_required: true,
      group_name: 'material',
      translations: {
        create: [
          { locale: 'en', label: 'Fabric', option_labels: { cotton: 'Cotton', polyester: 'Polyester', blend: 'Blend', silk: 'Silk', linen: 'Linen' } },
          { locale: 'ar', label: 'القماش', option_labels: { cotton: 'قطن', polyester: 'بوليستر', blend: 'مزيج', silk: 'حرير', linen: 'كتان' } },
        ],
      },
    },
  });

  const sizes = await prisma.attributeTemplate.upsert({
    where: { id: 'attr-sizes' },
    update: {},
    create: {
      id: 'attr-sizes',
      name: 'sizes',
      type: 'MULTI_SELECT',
      options: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
      is_required: true,
      group_name: 'sizing',
      translations: {
        create: [
          { locale: 'en', label: 'Available Sizes' },
          { locale: 'ar', label: 'المقاسات المتاحة' },
        ],
      },
    },
  });

  const colors = await prisma.attributeTemplate.upsert({
    where: { id: 'attr-colors' },
    update: {},
    create: {
      id: 'attr-colors',
      name: 'colors',
      type: 'MULTI_SELECT',
      options: ['white', 'black', 'red', 'blue', 'green', 'gray', 'navy'],
      group_name: 'appearance',
      translations: {
        create: [
          { locale: 'en', label: 'Available Colors' },
          { locale: 'ar', label: 'الألوان المتاحة' },
        ],
      },
    },
  });

  const printArea = await prisma.attributeTemplate.upsert({
    where: { id: 'attr-print-area' },
    update: {},
    create: {
      id: 'attr-print-area',
      name: 'print_area',
      type: 'DIMENSIONS',
      unit: 'cm',
      group_name: 'customization',
      translations: {
        create: [
          { locale: 'en', label: 'Print Area' },
          { locale: 'ar', label: 'مساحة الطباعة' },
        ],
      },
    },
  });

  const printMethod = await prisma.attributeTemplate.upsert({
    where: { id: 'attr-print-method' },
    update: {},
    create: {
      id: 'attr-print-method',
      name: 'print_method',
      type: 'SELECT',
      options: ['DTG', 'DTF', 'sublimation', 'screen_print'],
      group_name: 'customization',
      translations: {
        create: [
          { locale: 'en', label: 'Print Method' },
          { locale: 'ar', label: 'طريقة الطباعة' },
        ],
      },
    },
  });

  const woodType = await prisma.attributeTemplate.upsert({
    where: { id: 'attr-wood-type' },
    update: {},
    create: {
      id: 'attr-wood-type',
      name: 'wood_type',
      type: 'SELECT',
      options: ['bamboo', 'walnut', 'maple', 'oak', 'cherry'],
      is_required: true,
      group_name: 'material',
      translations: {
        create: [
          { locale: 'en', label: 'Wood Type', option_labels: { bamboo: 'Bamboo', walnut: 'Walnut', maple: 'Maple', oak: 'Oak', cherry: 'Cherry' } },
          { locale: 'ar', label: 'نوع الخشب', option_labels: { bamboo: 'بامبو', walnut: 'جوز', maple: 'قيقب', oak: 'بلوط', cherry: 'كرز' } },
        ],
      },
    },
  });

  const foodSafe = await prisma.attributeTemplate.upsert({
    where: { id: 'attr-food-safe' },
    update: {},
    create: {
      id: 'attr-food-safe',
      name: 'food_safe',
      type: 'BOOLEAN',
      group_name: 'compliance',
      translations: {
        create: [
          { locale: 'en', label: 'Food Safe' },
          { locale: 'ar', label: 'آمن للطعام' },
        ],
      },
    },
  });

  console.log('Attribute templates created');

  // ======================
  // Categories
  // ======================
  const apparel = await prisma.category.upsert({
    where: { slug: 'apparel' },
    update: {},
    create: {
      slug: 'apparel',
      icon: 'shirt',
      sort_order: 1,
      translations: {
        create: [
          { locale: 'en', name: 'Apparel', description: 'Clothing and fashion' },
          { locale: 'ar', name: 'ملابس', description: 'ملابس وأزياء' },
        ],
      },
    },
  });

  const printedShirts = await prisma.category.upsert({
    where: { slug: 'printed-shirts' },
    update: {},
    create: {
      slug: 'printed-shirts',
      parent_id: apparel.id,
      icon: 'tshirt',
      sort_order: 1,
      translations: {
        create: [
          { locale: 'en', name: 'Printed Shirts', description: 'Custom printed t-shirts' },
          { locale: 'ar', name: 'قمصان مطبوعة', description: 'قمصان مطبوعة مخصصة' },
        ],
      },
    },
  });

  const woodProducts = await prisma.category.upsert({
    where: { slug: 'wood-products' },
    update: {},
    create: {
      slug: 'wood-products',
      icon: 'tree',
      sort_order: 2,
      translations: {
        create: [
          { locale: 'en', name: 'Wood Products', description: 'Laser engraved wood items' },
          { locale: 'ar', name: 'منتجات خشبية', description: 'منتجات خشبية محفورة بالليزر' },
        ],
      },
    },
  });

  const jewelry = await prisma.category.upsert({
    where: { slug: 'jewelry' },
    update: {},
    create: {
      slug: 'jewelry',
      icon: 'gem',
      sort_order: 3,
      translations: {
        create: [
          { locale: 'en', name: 'Jewelry', description: 'Custom jewelry and accessories' },
          { locale: 'ar', name: 'مجوهرات', description: 'مجوهرات وإكسسوارات مخصصة' },
        ],
      },
    },
  });

  console.log('Categories created');

  // ربط Attributes بالفئات
  await prisma.categoryAttributeTemplate.createMany({
    data: [
      // قمصان مطبوعة
      { category_id: printedShirts.id, template_id: fabric.id },
      { category_id: printedShirts.id, template_id: sizes.id },
      { category_id: printedShirts.id, template_id: colors.id },
      { category_id: printedShirts.id, template_id: printArea.id },
      { category_id: printedShirts.id, template_id: printMethod.id },
      // منتجات خشبية
      { category_id: woodProducts.id, template_id: woodType.id },
      { category_id: woodProducts.id, template_id: foodSafe.id },
    ],
    skipDuplicates: true,
  });

  console.log('Category-Attribute links created');

  await seedLegalPages();
  await seedNotificationTemplates();

  console.log('Seed completed!');
}

// ── Legal pages (privacy / terms / refund / shipping) ────────────────────────
// Idempotent: upsert with `update: {}` so the admin's edits in production are
// never overwritten by re-running the seed.
async function seedLegalPages() {
  const TITLES: Record<string, Record<string, string>> = {
    privacy:  { en: 'Privacy Policy',   ar: 'سياسة الخصوصية', tr: 'Gizlilik Politikası', de: 'Datenschutzerklärung', fr: 'Politique de confidentialité', sv: 'Integritetspolicy' },
    terms:    { en: 'Terms of Service', ar: 'الشروط والأحكام', tr: 'Hizmet Şartları',     de: 'Nutzungsbedingungen',  fr: "Conditions d'utilisation",     sv: 'Användarvillkor' },
    refund:   { en: 'Refund Policy',    ar: 'سياسة الاسترجاع', tr: 'İade Politikası',     de: 'Rückerstattungsrichtlinie', fr: 'Politique de remboursement', sv: 'Återbetalningspolicy' },
    shipping: { en: 'Shipping Policy',  ar: 'سياسة الشحن',    tr: 'Kargo Politikası',    de: 'Versandrichtlinie',    fr: "Politique d'expédition",       sv: 'Fraktpolicy' },
  };
  const placeholder = (title: string) =>
    `<p><em>This is a placeholder for the ${title}. Edit it from the admin dashboard.</em></p>`;

  let created = 0;
  for (const [slug, titles] of Object.entries(TITLES)) {
    const content: Record<string, string> = {};
    for (const [loc, t] of Object.entries(titles)) content[loc] = placeholder(t);
    const res = await prisma.legalPage.upsert({
      where: { slug },
      update: {}, // never overwrite admin edits
      create: { slug, title: titles, content },
    });
    if (res) created++;
  }
  console.log(`Legal pages ensured (${created}/${Object.keys(TITLES).length})`);
}

// ── Notification templates (orders / welcome / password_reset / account_created
// / onboarding). Definitions: prisma/platform-email-templates.ts (shared with
// prisma/scripts/platform-email-templates-sync.ts, which updates an existing
// database). Idempotent (upsert with `update: {}`). Bodies use {{var}}
// placeholders the MailService substitutes at send time.
async function seedNotificationTemplates() {
  const TEMPLATES = buildPlatformEmailTemplates();
  let created = 0;
  for (const [event, perLocale] of Object.entries(TEMPLATES)) {
    const { subject, body_html, body_text } = toTemplateColumns(perLocale);
    const res = await prisma.notificationTemplate.upsert({
      where: { event },
      update: {}, // never overwrite admin edits
      create: { event, subject, body_html, body_text, enabled: true },
    });
    if (res) created++;
  }
  console.log(`Notification templates ensured (${created}/${Object.keys(TEMPLATES).length})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
