"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const bcrypt = __importStar(require("bcrypt"));
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('Seeding database...');
    const adminPassword = await bcrypt.hash('admin123456', 12);
    const admin = await prisma.user.upsert({
        where: { email: 'admin@multistores.com' },
        update: {},
        create: {
            email: 'admin@multistores.com',
            password_hash: adminPassword,
            role: client_1.UserRole.ADMIN,
            status: 'ACTIVE',
        },
    });
    console.log('Admin created:', admin.email);
    const providerPassword = await bcrypt.hash('provider123', 12);
    const providerUser = await prisma.user.upsert({
        where: { email: 'provider@test.com' },
        update: {},
        create: {
            email: 'provider@test.com',
            password_hash: providerPassword,
            role: client_1.UserRole.PROVIDER,
            status: 'ACTIVE',
            provider: {
                create: {
                    company_name: 'Test Manufacturing Co.',
                    description: 'Premium handmade products',
                    country: 'DE',
                    verified: true,
                },
            },
        },
    });
    console.log('Provider created:', providerUser.email);
    const creatorPassword = await bcrypt.hash('creator123', 12);
    const creatorUser = await prisma.user.upsert({
        where: { email: 'creator@test.com' },
        update: {},
        create: {
            email: 'creator@test.com',
            password_hash: creatorPassword,
            role: client_1.UserRole.CREATOR,
            status: 'ACTIVE',
            creator: {
                create: {
                    display_name: 'Ahmed Design',
                    bio: 'Creative designer specializing in custom products',
                    verified: true,
                },
            },
        },
    });
    console.log('Creator created:', creatorUser.email);
    const creator = await prisma.creator.findUnique({ where: { user_id: creatorUser.id } });
    if (creator) {
        await prisma.store.upsert({
            where: { creator_id: creator.id },
            update: {},
            create: {
                creator_id: creator.id,
                name: 'Ahmed Design Store',
                slug: 'ahmed-design',
                description: 'Custom designed products by Ahmed',
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
        console.log('Store created for creator');
    }
    const customerPassword = await bcrypt.hash('customer123', 12);
    const customerUser = await prisma.user.upsert({
        where: { email: 'customer@test.com' },
        update: {},
        create: {
            email: 'customer@test.com',
            password_hash: customerPassword,
            role: client_1.UserRole.CUSTOMER,
            status: 'ACTIVE',
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
    await prisma.categoryAttributeTemplate.createMany({
        data: [
            { category_id: printedShirts.id, template_id: fabric.id },
            { category_id: printedShirts.id, template_id: sizes.id },
            { category_id: printedShirts.id, template_id: colors.id },
            { category_id: printedShirts.id, template_id: printArea.id },
            { category_id: printedShirts.id, template_id: printMethod.id },
            { category_id: woodProducts.id, template_id: woodType.id },
            { category_id: woodProducts.id, template_id: foodSafe.id },
        ],
        skipDuplicates: true,
    });
    console.log('Category-Attribute links created');
    console.log('Seed completed!');
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map