import { PageType } from '@prisma/client';
import type { Kit } from './types';

// ── Shoes — Modern ──────────────────────────────────────────────
// A bold, contemporary sneaker/footwear storefront kit. Composed entirely
// from the existing section catalogue. Bilingual EN + AR content; images use
// "@asset/<key>" placeholders resolved to the store's uploads on import
// (Phase 2). Until real assets ship, image-bearing sections degrade gracefully
// to their empty/overlay states.

export const shoesModernKit: Kit = {
  id: 'shoes-modern',
  name: { en: 'Shoes — Modern', ar: 'أحذية — عصري' },
  description: {
    en: 'A bold, contemporary footwear store: full-bleed hero, best-sellers, editorial story, reviews and a complete product page.',
    ar: 'متجر أحذية عصري وجريء: بانر كامل، الأكثر مبيعاً، قصة تحريرية، آراء العملاء، وصفحة منتج كاملة.',
  },
  tags: ['footwear', 'fashion', 'sneakers', 'retail'],
  previewImage: '@asset/preview',
  themeKey: 'minimal',
  fallbackLocale: 'en',
  // Modern monochrome base with a warm accent — reads premium and energetic.
  themeCustomizations: {
    colors: {
      primary: '#111111',
      secondary: '#1f2937',
      accent: '#f97316',
      background: '#ffffff',
      surface: '#f5f5f4',
      text: '#171717',
      muted: '#737373',
      border: '#e7e5e4',
      primaryContrast: '#ffffff',
    },
    typography: {
      fontFamily: {
        heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
        body: 'Inter, ui-sans-serif, system-ui, sans-serif',
      },
    },
  },
  assets: {
    preview: { file: 'preview.jpg' },
    'hero-1': { file: 'hero-1.jpg', alt: 'Featured sneaker on a bold background' },
    'hero-2': { file: 'hero-2.jpg', alt: 'Runner mid-stride wearing the collection' },
    editorial: { file: 'editorial.jpg', alt: 'Close-up of premium shoe craftsmanship' },
    'logo-1': { file: 'logo-1.svg' },
    'logo-2': { file: 'logo-2.svg' },
    'logo-3': { file: 'logo-3.svg' },
    'logo-4': { file: 'logo-4.svg' },
    'logo-5': { file: 'logo-5.svg' },
    'gallery-1': { file: 'gallery-1.jpg' },
    'gallery-2': { file: 'gallery-2.jpg' },
    'gallery-3': { file: 'gallery-3.jpg' },
    'gallery-4': { file: 'gallery-4.jpg' },
    'gallery-5': { file: 'gallery-5.jpg' },
    'gallery-6': { file: 'gallery-6.jpg' },
    'testi-1': { file: 'testi-1.jpg' },
    'testi-2': { file: 'testi-2.jpg' },
    'testi-3': { file: 'testi-3.jpg' },
    'shoe-1': { file: 'shoe-1.jpg' },
    'shoe-2': { file: 'shoe-2.jpg' },
    'shoe-3': { file: 'shoe-3.jpg' },
    'shoe-4': { file: 'shoe-4.jpg' },
  },

  pages: [
    // ── HEADER ──────────────────────────────────────────────
    {
      type: PageType.HEADER,
      sections: [
        {
          section_key: 'announcement-bar',
          settings: { layout: 'rotating', rotate_ms: 5000 },
          content: {
            en: { messages: [
              { text: 'Free shipping on orders over $50' },
              { text: '30-day easy returns', link_label: 'Learn more', link_url: '/pages/returns' },
            ] },
            ar: { messages: [
              { text: 'شحن مجاني للطلبات فوق ‎$50' },
              { text: 'إرجاع سهل خلال 30 يوماً', link_label: 'اعرف أكثر', link_url: '/pages/returns' },
            ] },
          },
        },
        {
          section_key: 'header-bar',
          settings: {
            show_logo: true, show_store_name: true, show_search: true,
            show_cart: true, show_account: true, show_locale: true, sticky_mode: 'always',
          },
          content: {
            en: { items: [
              { label: 'New', url: '/products' },
              { label: 'Men', url: '/collections/men' },
              { label: 'Women', url: '/collections/women' },
              { label: 'Sale', url: '/collections/sale' },
            ] },
            ar: { items: [
              { label: 'جديد', url: '/products' },
              { label: 'رجال', url: '/collections/men' },
              { label: 'نساء', url: '/collections/women' },
              { label: 'تخفيضات', url: '/collections/sale' },
            ] },
          },
        },
      ],
    },

    // ── HOME ────────────────────────────────────────────────
    {
      type: PageType.HOME,
      translations: [
        { locale: 'en', title: 'Home' },
        { locale: 'ar', title: 'الرئيسية' },
      ],
      sections: [
        {
          section_key: 'hero-slider',
          settings: { height: 'lg', overlay_opacity: 0.45, autoplay_ms: 5000, show_arrows: true, show_dots: true, loop: true },
          content: {
            en: { slides: [
              { image: '@asset/hero-1', eyebrow: 'New season', heading: 'Step Into the Season', subheading: 'Engineered for comfort, built to stand out.', cta_text: 'Shop now', cta_url: '/products', alignment: 'left' },
              { image: '@asset/hero-2', eyebrow: 'Best sellers', heading: 'Move Different', subheading: 'The drops everyone is talking about.', cta_text: 'Explore', cta_url: '/collections/sale', alignment: 'center' },
            ] },
            ar: { slides: [
              { image: '@asset/hero-1', eyebrow: 'موسم جديد', heading: 'انطلق مع الموسم', subheading: 'صُمّمت للراحة، وبُنيت لتتميّز.', cta_text: 'تسوّق الآن', cta_url: '/products', alignment: 'right' },
              { image: '@asset/hero-2', eyebrow: 'الأكثر مبيعاً', heading: 'تحرّك بأسلوبك', subheading: 'الإصدارات التي يتحدّث عنها الجميع.', cta_text: 'اكتشف', cta_url: '/collections/sale', alignment: 'center' },
            ] },
          },
        },
        {
          section_key: 'logo-list',
          settings: { columns: 5, grayscale: true },
          content: {
            en: { heading: 'As seen in', items: [
              { image: '@asset/logo-1' }, { image: '@asset/logo-2' }, { image: '@asset/logo-3' },
              { image: '@asset/logo-4' }, { image: '@asset/logo-5' },
            ] },
            ar: { heading: 'ظهرنا في', items: [
              { image: '@asset/logo-1' }, { image: '@asset/logo-2' }, { image: '@asset/logo-3' },
              { image: '@asset/logo-4' }, { image: '@asset/logo-5' },
            ] },
          },
        },
        {
          section_key: 'feature-grid',
          settings: { columns: 4, alignment: 'center', icon_style: 'chip' },
          content: {
            en: { heading: 'Why shop with us', items: [
              { icon: 'truck', title: 'Fast delivery', description: 'Express shipping on every order.' },
              { icon: 'refresh', title: '30-day returns', description: 'Changed your mind? Send it back free.' },
              { icon: 'shield', title: 'Secure checkout', description: 'Protected, encrypted payments.' },
              { icon: 'award', title: 'Authentic', description: '100% genuine, guaranteed.' },
            ] },
            ar: { heading: 'لماذا تتسوّق معنا', items: [
              { icon: 'truck', title: 'توصيل سريع', description: 'شحن سريع لكل طلب.' },
              { icon: 'refresh', title: 'إرجاع 30 يوماً', description: 'غيّرت رأيك؟ أعِده مجاناً.' },
              { icon: 'shield', title: 'دفع آمن', description: 'مدفوعات محميّة ومشفّرة.' },
              { icon: 'award', title: 'أصلي', description: 'منتجات أصلية 100% ومضمونة.' },
            ] },
          },
        },
        {
          section_key: 'featured-products',
          settings: { filter: 'newest', limit: 4, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'New arrivals', subheading: 'Fresh drops, just landed.', link_label: 'View all', link_url: '/products' },
            ar: { heading: 'وصل حديثاً', subheading: 'أحدث الإصدارات، وصلت للتو.', link_label: 'عرض الكل', link_url: '/products' },
          },
        },
        {
          section_key: 'image-with-text',
          settings: { image: '@asset/editorial', image_position: 'left', aspect: 'square', cta_url: '/products' },
          content: {
            en: { eyebrow: 'Crafted to last', heading: 'Engineered for comfort', body: 'Premium materials, responsive cushioning and a fit that moves with you — from the first step to the last mile.', cta_text: 'Discover the tech' },
            ar: { eyebrow: 'صُنعت لتدوم', heading: 'صُمّمت للراحة', body: 'خامات فاخرة، توسيد مرن، ومقاس يتحرّك معك — من الخطوة الأولى حتى آخر ميل.', cta_text: 'اكتشف التقنية' },
          },
        },
        {
          section_key: 'collection-products',
          settings: { category: 'shoes', limit: 8, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'Best sellers', subheading: 'The pairs everyone is wearing.', link_label: 'Shop the collection' },
            ar: { heading: 'الأكثر مبيعاً', subheading: 'الأحذية التي يرتديها الجميع.', link_label: 'تسوّق المجموعة' },
          },
        },
        {
          section_key: 'countdown',
          settings: { target_date: '2026-12-31T23:59', alignment: 'center' },
          content: {
            en: { heading: 'Mid-season sale', subheading: "Up to 40% off — don't miss out.", expired_text: 'The sale has ended' },
            ar: { heading: 'تخفيضات منتصف الموسم', subheading: 'خصم حتى 40% — لا تفوّت الفرصة.', expired_text: 'انتهت التخفيضات' },
          },
        },
        {
          section_key: 'stats-bar',
          settings: { style: 'surface', columns: 3 },
          content: {
            en: { items: [
              { value: '10K', suffix: '+', label: 'Happy customers' },
              { value: '50K', suffix: '+', label: 'Pairs delivered' },
              { value: '4.9', suffix: '/5', label: 'Average rating' },
            ] },
            ar: { items: [
              { value: '10K', suffix: '+', label: 'عميل سعيد' },
              { value: '50K', suffix: '+', label: 'زوج تم توصيله' },
              { value: '4.9', suffix: '/5', label: 'متوسط التقييم' },
            ] },
          },
        },
        {
          section_key: 'testimonials',
          settings: { layout: 'cards', columns: 3, show_rating: true },
          content: {
            en: { heading: 'What our customers say', items: [
              { quote: 'Most comfortable sneakers I have ever owned. Worth every penny.', author: 'Sarah M.', role: 'Verified buyer', avatar: '@asset/testi-1', rating: 5 },
              { quote: 'Fast shipping and the quality is unreal. Already ordered a second pair.', author: 'Ahmed K.', role: 'Verified buyer', avatar: '@asset/testi-2', rating: 5 },
              { quote: 'Clean design, perfect fit. Exactly what I was looking for.', author: 'Lena P.', role: 'Verified buyer', avatar: '@asset/testi-3', rating: 4 },
            ] },
            ar: { heading: 'ماذا يقول عملاؤنا', items: [
              { quote: 'أكثر حذاء مريح امتلكته على الإطلاق. يستحق كل قرش.', author: 'سارة م.', role: 'مشترٍ موثّق', avatar: '@asset/testi-1', rating: 5 },
              { quote: 'شحن سريع وجودة لا تُصدّق. طلبت زوجاً ثانياً بالفعل.', author: 'أحمد ك.', role: 'مشترٍ موثّق', avatar: '@asset/testi-2', rating: 5 },
              { quote: 'تصميم أنيق ومقاس مثالي. تماماً ما كنت أبحث عنه.', author: 'لينا ب.', role: 'مشترٍ موثّق', avatar: '@asset/testi-3', rating: 4 },
            ] },
          },
        },
        {
          section_key: 'gallery-slider',
          settings: { slides_per_view: 3, slides_per_view_tablet: 2, slides_per_view_mobile: 1, gap_px: 16, aspect: 'square', show_caption: true, rounded: true, show_arrows: true, show_dots: true },
          content: {
            en: { heading: 'On the street', subheading: '#OurBrand in the wild', items: [
              { url: '@asset/gallery-1', alt: 'Street style 1' }, { url: '@asset/gallery-2', alt: 'Street style 2' },
              { url: '@asset/gallery-3', alt: 'Street style 3' }, { url: '@asset/gallery-4', alt: 'Street style 4' },
              { url: '@asset/gallery-5', alt: 'Street style 5' }, { url: '@asset/gallery-6', alt: 'Street style 6' },
            ] },
            ar: { heading: 'في الشارع', subheading: '#علامتنا في كل مكان', items: [
              { url: '@asset/gallery-1', alt: 'ستايل 1' }, { url: '@asset/gallery-2', alt: 'ستايل 2' },
              { url: '@asset/gallery-3', alt: 'ستايل 3' }, { url: '@asset/gallery-4', alt: 'ستايل 4' },
              { url: '@asset/gallery-5', alt: 'ستايل 5' }, { url: '@asset/gallery-6', alt: 'ستايل 6' },
            ] },
          },
        },
        {
          section_key: 'faq-list',
          settings: { layout: 'stacked', allow_multiple: true },
          content: {
            en: { heading: 'Frequently asked', items: [
              { question: 'How do I find my size?', answer: 'Check our size guide on each product page — most customers find their usual size fits true.' },
              { question: 'What is your return policy?', answer: 'Free returns within 30 days, no questions asked.' },
              { question: 'How long does shipping take?', answer: 'Express shipping arrives in 2–5 business days depending on your location.' },
            ] },
            ar: { heading: 'الأسئلة الشائعة', items: [
              { question: 'كيف أعرف مقاسي؟', answer: 'راجع دليل المقاسات في كل صفحة منتج — معظم العملاء يجدون مقاسهم المعتاد مناسباً.' },
              { question: 'ما سياسة الإرجاع؟', answer: 'إرجاع مجاني خلال 30 يوماً دون أي أسئلة.' },
              { question: 'كم يستغرق الشحن؟', answer: 'يصل الشحن السريع خلال 2–5 أيام عمل حسب موقعك.' },
            ] },
          },
        },
        {
          section_key: 'newsletter-signup',
          settings: { style: 'banner' },
          content: {
            en: { heading: 'Join the club', subheading: 'Get early access to drops and exclusive offers.', placeholder: 'your@email.com', button_label: 'Subscribe', success_message: "You're in — welcome!" },
            ar: { heading: 'انضم إلى النادي', subheading: 'احصل على وصول مبكر للإصدارات وعروض حصرية.', placeholder: 'your@email.com', button_label: 'اشترك', success_message: 'تم — أهلاً بك!' },
          },
        },
      ],
    },

    // ── FOOTER ──────────────────────────────────────────────
    {
      type: PageType.FOOTER,
      sections: [
        {
          section_key: 'footer-columns',
          content: {
            en: { columns: [
              { heading: 'Shop', links: [
                { label: 'New arrivals', url: '/products' },
                { label: 'Men', url: '/collections/men' },
                { label: 'Women', url: '/collections/women' },
                { label: 'Sale', url: '/collections/sale' },
              ] },
              { heading: 'Help', links: [
                { label: 'Size guide', url: '/pages/size-guide' },
                { label: 'Shipping', url: '/pages/shipping' },
                { label: 'Returns', url: '/pages/returns' },
                { label: 'Contact', url: '/pages/contact' },
              ] },
              { heading: 'Company', links: [
                { label: 'About us', url: '/pages/about' },
                { label: 'Sustainability', url: '/pages/sustainability' },
                { label: 'Careers', url: '/pages/careers' },
              ] },
            ] },
            ar: { columns: [
              { heading: 'تسوّق', links: [
                { label: 'وصل حديثاً', url: '/products' },
                { label: 'رجال', url: '/collections/men' },
                { label: 'نساء', url: '/collections/women' },
                { label: 'تخفيضات', url: '/collections/sale' },
              ] },
              { heading: 'المساعدة', links: [
                { label: 'دليل المقاسات', url: '/pages/size-guide' },
                { label: 'الشحن', url: '/pages/shipping' },
                { label: 'الإرجاع', url: '/pages/returns' },
                { label: 'تواصل معنا', url: '/pages/contact' },
              ] },
              { heading: 'الشركة', links: [
                { label: 'من نحن', url: '/pages/about' },
                { label: 'الاستدامة', url: '/pages/sustainability' },
                { label: 'وظائف', url: '/pages/careers' },
              ] },
            ] },
          },
        },
        {
          section_key: 'social-icons',
          settings: { layout: 'horizontal', alignment: 'center', icon_style: 'plain', size: 'md', color_mode: 'theme-text' },
          content: {
            en: { heading: 'Follow us', items: [
              { platform: 'instagram', url: 'https://instagram.com/' },
              { platform: 'tiktok', url: 'https://tiktok.com/' },
              { platform: 'facebook', url: 'https://facebook.com/' },
              { platform: 'youtube', url: 'https://youtube.com/' },
            ] },
            ar: { heading: 'تابعنا', items: [
              { platform: 'instagram', url: 'https://instagram.com/' },
              { platform: 'tiktok', url: 'https://tiktok.com/' },
              { platform: 'facebook', url: 'https://facebook.com/' },
              { platform: 'youtube', url: 'https://youtube.com/' },
            ] },
          },
        },
        {
          section_key: 'copyright-bar',
          settings: { alignment: 'between', show_payment_icons: true },
          content: {
            en: { text: '© {year} {store}. All rights reserved.', payment_methods: [
              { label: 'Visa' }, { label: 'Mastercard' }, { label: 'PayPal' }, { label: 'Apple Pay' },
            ] },
            ar: { text: '© {year} {store}. جميع الحقوق محفوظة.', payment_methods: [
              { label: 'Visa' }, { label: 'Mastercard' }, { label: 'PayPal' }, { label: 'Apple Pay' },
            ] },
          },
        },
      ],
    },

    // ── PRODUCT TEMPLATE ────────────────────────────────────
    {
      type: PageType.PRODUCT_TEMPLATE,
      sections: [
        {
          section_key: 'product-page',
          settings: { show_trust_badges: true, show_shipping: true, show_tabs: true, show_tags: true, button_style: 'solid' },
        },
      ],
    },
  ],

  // Optional demo data (created only when the creator opts in at import time).
  demoData: {
    category: {
      slug: 'shoes',
      translations: [
        { locale: 'en', name: 'Shoes' },
        { locale: 'ar', name: 'أحذية' },
      ],
    },
    products: [
      { title: { en: 'Aero Runner', ar: 'إيرو رَنر' }, base_price: 119, compare_at_price: 149, images: ['@asset/shoe-1'] },
      { title: { en: 'Street Classic', ar: 'ستريت كلاسيك' }, base_price: 99, images: ['@asset/shoe-2'] },
      { title: { en: 'Trail Pro', ar: 'تريل برو' }, base_price: 139, compare_at_price: 169, images: ['@asset/shoe-3'] },
      { title: { en: 'Court Low', ar: 'كورت لو' }, base_price: 89, images: ['@asset/shoe-4'] },
    ],
  },
};
