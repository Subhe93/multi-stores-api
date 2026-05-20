import { PageType } from '@prisma/client';
import type { Kit } from './types';

// ── Namez — Personalized Gifts ──────────────────────────────────
// A warm, family-friendly storefront for personalized 3D name gifts and
// student plaques, modelled on namez.se: teal brand, soft warm accents,
// handmade-in-Sweden story, lifestyle photography and social proof. Composed
// from the existing section catalogue (incl. steps, sticky-cta-bar). Bilingual
// EN + AR; images use "@asset/<key>" placeholders resolved on import. The
// bundled photos are real product/lifestyle reference shots.

export const namezGiftsKit: Kit = {
  id: 'namez-gifts',
  name: { en: 'Namez — Personalized Gifts', ar: 'هدايا شخصية — Namez' },
  description: {
    en: 'A warm storefront for personalized 3D name gifts and student plaques: lifestyle hero, how-it-works, bestsellers, reviews and a complete product page.',
    ar: 'متجر دافئ للهدايا الشخصية ثلاثية الأبعاد ولوحات الأسماء: بانر لايف-ستايل، كيف تعمل، الأكثر مبيعاً، آراء، وصفحة منتج كاملة.',
  },
  tags: ['gifts', 'personalized', '3d-print', 'handmade', 'family'],
  previewImage: '@asset/preview',
  themeKey: 'minimal',
  fallbackLocale: 'en',
  // Friendly teal brand with a warm amber accent — reads handmade and personal.
  themeCustomizations: {
    colors: {
      primary: '#0d9488',
      secondary: '#0f766e',
      accent: '#f59e0b',
      background: '#ffffff',
      surface: '#f6faf9',
      text: '#1f2937',
      muted: '#6b7280',
      border: '#e5e7eb',
      primaryContrast: '#ffffff',
    },
    typography: {
      fontFamily: {
        heading: 'Poppins, ui-sans-serif, system-ui, sans-serif',
        body: 'Inter, ui-sans-serif, system-ui, sans-serif',
      },
    },
  },
  assets: {
    preview: { file: 'preview.jpg', alt: 'Personalized 3D name gift' },
    'hero-1': { file: 'hero-1.jpg', alt: 'Father and daughter holding a 3D name' },
    'hero-2': { file: 'hero-2.jpg', alt: 'Family at home with personalized gifts' },
    'editorial-kids': { file: 'editorial-kids.jpg', alt: 'Child holding a personalized 3D name' },
    'editorial-necklace': { file: 'editorial-necklace.jpg', alt: '3D name necklace worn' },
    'gallery-1': { file: 'gallery-1.jpg' },
    'gallery-2': { file: 'gallery-2.jpg' },
    'gallery-3': { file: 'gallery-3.jpg' },
    'gallery-4': { file: 'gallery-4.jpg' },
    'gallery-5': { file: 'gallery-5.jpg' },
    'gallery-6': { file: 'gallery-6.jpg' },
    'prod-bigletter': { file: 'prod-bigletter.jpg', alt: '3D name plaque with capital letter' },
    'prod-standing': { file: 'prod-standing.jpg', alt: '3D standing name plaque' },
    'prod-dalahorse': { file: 'prod-dalahorse.jpg', alt: 'Modern Dala horse in silver' },
    'prod-keyring': { file: 'prod-keyring.jpg', alt: 'Personalized name keyring' },
    'prod-necklace': { file: 'prod-necklace.jpg', alt: '3D name necklace' },
    'prod-namekids': { file: 'prod-namekids.jpg', alt: 'Personalized 3D name for kids' },
    'stud-classic': { file: 'stud-classic.jpg', alt: 'Student plaque — classic design' },
    'stud-soft': { file: 'stud-soft.jpg', alt: 'Student plaque — soft design' },
    'stud-fast': { file: 'stud-fast.jpg', alt: 'Student plaque — fast delivery' },
    'stud-price': { file: 'stud-price.jpg', alt: 'Student plaque' },
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
              { text: 'Free delivery in 3–5 business days' },
              { text: '30-day returns · Pay safely with Klarna', link_label: 'Learn more', link_url: '/pages/shipping' },
            ] },
            ar: { messages: [
              { text: 'توصيل مجاني خلال 3–5 أيام عمل' },
              { text: 'إرجاع خلال 30 يوماً · دفع آمن', link_label: 'اعرف أكثر', link_url: '/pages/shipping' },
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
              { label: 'Shop', url: '/products' },
              { label: 'Gifts', url: '/collections/gifts' },
              { label: 'Student plaques', url: '/collections/student' },
              { label: 'About us', url: '/pages/about' },
            ] },
            ar: { items: [
              { label: 'المتجر', url: '/products' },
              { label: 'الهدايا', url: '/collections/gifts' },
              { label: 'لوحات الطلاب', url: '/collections/student' },
              { label: 'من نحن', url: '/pages/about' },
            ] },
          },
        },
      ],
    },

    // ── HOME ────────────────────────────────────────────────
    {
      type: PageType.HOME,
      translations: [
        { locale: 'en', title: 'Home', meta_title: 'Personalized 3D Name Gifts', meta_description: 'Handmade personalized 3D name gifts and student plaques. Designed and crafted in Sweden, delivered in 3–5 days.' },
        { locale: 'ar', title: 'الرئيسية', meta_title: 'هدايا أسماء ثلاثية الأبعاد', meta_description: 'هدايا أسماء شخصية ثلاثية الأبعاد ولوحات طلاب مصنوعة يدوياً. تُصمَّم وتُصنَع بحب وتُشحَن خلال 3–5 أيام.' },
      ],
      sections: [
        {
          section_key: 'hero-slider',
          settings: { height: 'lg', overlay_opacity: 0.4, autoplay_ms: 6000, show_arrows: true, show_dots: true, loop: true },
          content: {
            en: { slides: [
              { image: '@asset/hero-1', eyebrow: 'Handmade in Sweden', heading: 'Gifts as personal as their name', subheading: 'Custom 3D name plaques and keepsakes, crafted with love and delivered in 3–5 days.', cta_text: 'Create your gift', cta_url: '/products', alignment: 'left' },
              { image: '@asset/hero-2', eyebrow: 'For every occasion', heading: 'A keepsake they will treasure', subheading: 'Birthdays, graduations, newborns — make the moment unforgettable.', cta_text: 'Shop gifts', cta_url: '/collections/gifts', alignment: 'center' },
            ] },
            ar: { slides: [
              { image: '@asset/hero-1', eyebrow: 'صناعة يدوية', heading: 'هدايا شخصية بقدر اسمهم', subheading: 'لوحات أسماء ثلاثية الأبعاد وتذكارات مصنوعة بحب وتُشحَن خلال 3–5 أيام.', cta_text: 'اصنع هديتك', cta_url: '/products', alignment: 'right' },
              { image: '@asset/hero-2', eyebrow: 'لكل مناسبة', heading: 'تذكار يحفظونه طوال العمر', subheading: 'أعياد ميلاد، تخرّج، مواليد — اجعل اللحظة لا تُنسى.', cta_text: 'تسوّق الهدايا', cta_url: '/collections/gifts', alignment: 'center' },
            ] },
          },
        },
        {
          section_key: 'feature-grid',
          settings: { columns: 4, alignment: 'center', icon_style: 'chip' },
          content: {
            en: { heading: 'Why shop with us', items: [
              { icon: 'truck', title: 'Fast delivery', description: 'Within 3–5 business days.' },
              { icon: 'refresh', title: '30-day returns', description: 'Not happy? Send it back.' },
              { icon: 'card', title: 'Secure checkout', description: 'Pay safely with Klarna and cards.' },
              { icon: 'headphones', title: 'Friendly support', description: 'We are here to help, 7 days a week.' },
            ] },
            ar: { heading: 'لماذا تتسوّق معنا', items: [
              { icon: 'truck', title: 'توصيل سريع', description: 'خلال 3–5 أيام عمل.' },
              { icon: 'refresh', title: 'إرجاع 30 يوماً', description: 'لم يعجبك؟ أعِده ببساطة.' },
              { icon: 'card', title: 'دفع آمن', description: 'ادفع بأمان بالبطاقات والمحافظ.' },
              { icon: 'headphones', title: 'دعم ودود', description: 'نحن هنا لمساعدتك طوال الأسبوع.' },
            ] },
          },
        },
        {
          section_key: 'featured-products',
          settings: { filter: 'newest', limit: 4, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'Student plaques 2026', subheading: 'Celebrate the big day with a personalized keepsake.', link_label: 'View all', link_url: '/collections/student' },
            ar: { heading: 'لوحات التخرّج 2026', subheading: 'احتفل باليوم الكبير بتذكار شخصي.', link_label: 'عرض الكل', link_url: '/collections/student' },
          },
        },
        {
          section_key: 'stats-bar',
          settings: { style: 'surface', columns: 4 },
          content: {
            en: { items: [
              { value: '2800', suffix: '+', label: 'Happy customers' },
              { value: '80', suffix: '%', label: 'Returning customers' },
              { value: '98', suffix: '%', label: 'Satisfaction' },
              { value: '4', suffix: ' yrs', label: 'Crafting gifts' },
            ] },
            ar: { items: [
              { value: '2800', suffix: '+', label: 'عميل سعيد' },
              { value: '80', suffix: '%', label: 'عملاء عائدون' },
              { value: '98', suffix: '%', label: 'نسبة الرضا' },
              { value: '4', suffix: ' سنوات', label: 'في صناعة الهدايا' },
            ] },
          },
        },
        {
          section_key: 'image-with-text',
          settings: { image: '@asset/editorial-kids', image_position: 'left', aspect: 'landscape', cta_url: '/products' },
          content: {
            en: { eyebrow: 'Made personal', heading: 'Their name, beautifully crafted', body: 'Every piece is designed around the name you choose and finished by hand in our workshop in Dalarna, Sweden. A gift that feels made for them — because it is.', cta_text: 'Start designing' },
            ar: { eyebrow: 'شخصية بالكامل', heading: 'اسمهم، مصنوع بإتقان', body: 'كل قطعة تُصمَّم حول الاسم الذي تختاره وتُنهى يدوياً في ورشتنا في السويد. هدية تبدو وكأنها صُنعت لهم — لأنها كذلك فعلاً.', cta_text: 'ابدأ التصميم' },
          },
        },
        {
          section_key: 'steps',
          settings: { columns: 3, show_connector: true },
          content: {
            en: { heading: 'How it works', subheading: 'A personal gift in three simple steps.', items: [
              { title: 'Choose', description: 'Pick a design you love from our collection.' },
              { title: 'Personalize', description: 'Add the name, colour and details.' },
              { title: 'We craft & ship', description: 'Handmade and delivered in 3–5 days.' },
            ] },
            ar: { heading: 'كيف تعمل', subheading: 'هدية شخصية في ثلاث خطوات بسيطة.', items: [
              { title: 'اختر', description: 'اختر تصميماً يعجبك من مجموعتنا.' },
              { title: 'خصّص', description: 'أضف الاسم واللون والتفاصيل.' },
              { title: 'نصنع ونشحن', description: 'صناعة يدوية وتوصيل خلال 3–5 أيام.' },
            ] },
          },
        },
        {
          section_key: 'collection-products',
          settings: { category: 'personalized-gifts', limit: 8, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'Personal gifts', subheading: 'Loved by families across the country.', link_label: 'Shop the collection' },
            ar: { heading: 'هدايا شخصية', subheading: 'محبوبة من العائلات في كل مكان.', link_label: 'تسوّق المجموعة' },
          },
        },
        {
          section_key: 'image-with-text',
          settings: { image: '@asset/editorial-necklace', image_position: 'right', aspect: 'landscape', cta_url: '/products' },
          content: {
            en: { eyebrow: 'Wear their name', heading: 'Keepsakes you can carry', body: 'From standing name plaques to delicate 3D necklaces and keyrings — choose the keepsake that fits the moment, all personalized just for them.', cta_text: 'Explore keepsakes' },
            ar: { eyebrow: 'احمل اسمهم', heading: 'تذكارات ترافقك أينما ذهبت', body: 'من لوحات الأسماء الواقفة إلى القلائد والميداليات ثلاثية الأبعاد — اختر التذكار المناسب للحظة، وكلها مخصّصة لهم وحدهم.', cta_text: 'اكتشف التذكارات' },
          },
        },
        {
          section_key: 'testimonials',
          settings: { layout: 'cards', columns: 3, show_rating: true },
          content: {
            en: { heading: 'Loved by 2,800+ customers', items: [
              { quote: 'The quality blew me away — my daughter lights up every time she sees her name.', author: 'Emma L.', role: 'Verified buyer', rating: 5 },
              { quote: 'Ordered a graduation plaque, arrived in three days and looked even better in person.', author: 'Johan B.', role: 'Verified buyer', rating: 5 },
              { quote: 'Such a thoughtful gift and beautifully made. I have already ordered two more.', author: 'Sara K.', role: 'Verified buyer', rating: 5 },
            ] },
            ar: { heading: 'محبوب من أكثر من 2800 عميل', items: [
              { quote: 'الجودة أذهلتني — تبتسم ابنتي كلما رأت اسمها.', author: 'إيما ل.', role: 'مشترٍ موثّق', rating: 5 },
              { quote: 'طلبت لوحة تخرّج، وصلت خلال ثلاثة أيام وبدت أجمل على الطبيعة.', author: 'يوهان ب.', role: 'مشترٍ موثّق', rating: 5 },
              { quote: 'هدية مدروسة ومصنوعة بإتقان. طلبت اثنتين أخريين بالفعل.', author: 'سارة ك.', role: 'مشترٍ موثّق', rating: 5 },
            ] },
          },
        },
        {
          section_key: 'trust-badges',
          settings: { layout: 'cards', padding: 'comfortable' },
          content: {
            en: { items: [
              { icon: 'award', label: 'Handmade in Sweden', description: 'Crafted in Dalarna' },
              { icon: 'truck', label: 'Fast delivery', description: '3–5 business days' },
              { icon: 'refresh', label: '30-day returns', description: 'Shop with confidence' },
              { icon: 'card', label: 'Secure payment', description: 'Klarna & major cards' },
            ] },
            ar: { items: [
              { icon: 'award', label: 'صناعة يدوية', description: 'تُصنَع بحب' },
              { icon: 'truck', label: 'توصيل سريع', description: '3–5 أيام عمل' },
              { icon: 'refresh', label: 'إرجاع 30 يوماً', description: 'تسوّق باطمئنان' },
              { icon: 'card', label: 'دفع آمن', description: 'بطاقات ومحافظ موثوقة' },
            ] },
          },
        },
        {
          section_key: 'gallery-slider',
          settings: { slides_per_view: 3, slides_per_view_tablet: 2, slides_per_view_mobile: 1, gap_px: 16, aspect: 'square', show_caption: false, rounded: true, show_arrows: true, show_dots: true },
          content: {
            en: { heading: 'From our workshop', subheading: 'A few of our favourite creations.', items: [
              { url: '@asset/gallery-1', alt: 'Capital letter name plaque' },
              { url: '@asset/gallery-2', alt: 'Standing name plaque' },
              { url: '@asset/gallery-3', alt: 'Silver Dala horse' },
              { url: '@asset/gallery-4', alt: 'Name keyring' },
              { url: '@asset/gallery-5', alt: 'Name necklace' },
              { url: '@asset/gallery-6', alt: 'Child with name' },
            ] },
            ar: { heading: 'من ورشتنا', subheading: 'بعض إبداعاتنا المفضّلة.', items: [
              { url: '@asset/gallery-1', alt: 'لوحة اسم بحرف كبير' },
              { url: '@asset/gallery-2', alt: 'لوحة اسم واقفة' },
              { url: '@asset/gallery-3', alt: 'حصان دالا فضي' },
              { url: '@asset/gallery-4', alt: 'ميدالية مفاتيح بالاسم' },
              { url: '@asset/gallery-5', alt: 'قلادة بالاسم' },
              { url: '@asset/gallery-6', alt: 'طفلة مع اسمها' },
            ] },
          },
        },
        {
          section_key: 'faq-list',
          settings: { layout: 'stacked', allow_multiple: true },
          content: {
            en: { heading: 'Frequently asked', items: [
              { question: 'How long does delivery take?', answer: 'Most orders are handmade and shipped within 3–5 business days inside Sweden.' },
              { question: 'Can I choose any name?', answer: 'Yes — every piece is personalized with the name, colour and details you choose at checkout.' },
              { question: 'What is your return policy?', answer: 'If you are not happy, you can return your order within 30 days.' },
              { question: 'How can I pay?', answer: 'Pay safely with Klarna, Apple Pay, Google Pay, Visa or Mastercard.' },
            ] },
            ar: { heading: 'الأسئلة الشائعة', items: [
              { question: 'كم يستغرق التوصيل؟', answer: 'تُصنَع معظم الطلبات يدوياً وتُشحَن خلال 3–5 أيام عمل.' },
              { question: 'هل أستطيع اختيار أي اسم؟', answer: 'نعم — كل قطعة تُخصَّص بالاسم واللون والتفاصيل التي تختارها عند الدفع.' },
              { question: 'ما سياسة الإرجاع؟', answer: 'إن لم تكن راضياً، يمكنك إرجاع طلبك خلال 30 يوماً.' },
              { question: 'كيف يمكنني الدفع؟', answer: 'ادفع بأمان عبر المحافظ الرقمية وبطاقات Visa وMastercard.' },
            ] },
          },
        },
        {
          section_key: 'newsletter-signup',
          settings: { style: 'banner' },
          content: {
            en: { heading: 'Get 10% off your first gift', subheading: 'Join our list for new designs and seasonal offers.', placeholder: 'your@email.com', button_label: 'Subscribe', success_message: "You're in — check your inbox!" },
            ar: { heading: 'احصل على خصم 10% على أول هدية', subheading: 'انضم إلى قائمتنا للتصاميم الجديدة والعروض الموسمية.', placeholder: 'your@email.com', button_label: 'اشترك', success_message: 'تم — تفقّد بريدك!' },
          },
        },
        {
          section_key: 'sticky-cta-bar',
          settings: { show_after_px: 600, show_close: true },
          content: {
            en: { text: 'Handmade in Sweden · Delivered in 3–5 days', cta_text: 'Create your gift' },
            ar: { text: 'صناعة يدوية · توصيل خلال 3–5 أيام', cta_text: 'اصنع هديتك' },
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
                { label: 'All gifts', url: '/products' },
                { label: 'Student plaques', url: '/collections/student' },
                { label: 'Name plaques', url: '/collections/gifts' },
                { label: 'Keepsakes', url: '/products' },
              ] },
              { heading: 'Help', links: [
                { label: 'Shipping & returns', url: '/pages/shipping' },
                { label: 'Satisfaction guarantee', url: '/pages/guarantee' },
                { label: 'Customer service', url: '/pages/contact' },
                { label: 'Track my order', url: '/account/orders' },
              ] },
              { heading: 'Company', links: [
                { label: 'About us', url: '/pages/about' },
                { label: 'Our workshop', url: '/pages/workshop' },
                { label: 'Cookies', url: '/pages/cookies' },
              ] },
            ] },
            ar: { columns: [
              { heading: 'تسوّق', links: [
                { label: 'كل الهدايا', url: '/products' },
                { label: 'لوحات الطلاب', url: '/collections/student' },
                { label: 'لوحات الأسماء', url: '/collections/gifts' },
                { label: 'التذكارات', url: '/products' },
              ] },
              { heading: 'المساعدة', links: [
                { label: 'الشحن والإرجاع', url: '/pages/shipping' },
                { label: 'ضمان الرضا', url: '/pages/guarantee' },
                { label: 'خدمة العملاء', url: '/pages/contact' },
                { label: 'تتبّع طلبي', url: '/account/orders' },
              ] },
              { heading: 'الشركة', links: [
                { label: 'من نحن', url: '/pages/about' },
                { label: 'ورشتنا', url: '/pages/workshop' },
                { label: 'ملفات الارتباط', url: '/pages/cookies' },
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
              { platform: 'facebook', url: 'https://facebook.com/' },
              { platform: 'tiktok', url: 'https://tiktok.com/' },
            ] },
            ar: { heading: 'تابعنا', items: [
              { platform: 'instagram', url: 'https://instagram.com/' },
              { platform: 'facebook', url: 'https://facebook.com/' },
              { platform: 'tiktok', url: 'https://tiktok.com/' },
            ] },
          },
        },
        {
          section_key: 'copyright-bar',
          settings: { alignment: 'between', show_payment_icons: true },
          content: {
            en: { text: '© {year} {store}. All rights reserved.', payment_methods: [
              { label: 'Klarna' }, { label: 'Visa' }, { label: 'Mastercard' }, { label: 'Apple Pay' }, { label: 'Google Pay' },
            ] },
            ar: { text: '© {year} {store}. جميع الحقوق محفوظة.', payment_methods: [
              { label: 'Klarna' }, { label: 'Visa' }, { label: 'Mastercard' }, { label: 'Apple Pay' }, { label: 'Google Pay' },
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
      slug: 'personalized-gifts',
      translations: [
        { locale: 'en', name: 'Personalized Gifts' },
        { locale: 'ar', name: 'هدايا شخصية' },
      ],
    },
    products: [
      { title: { en: '3D Name Plaque — Capital Letter', ar: 'لوحة اسم ثلاثية الأبعاد — حرف كبير' }, base_price: 275, images: ['@asset/prod-bigletter'] },
      { title: { en: '3D Standing Name Plaque', ar: 'لوحة اسم واقفة ثلاثية الأبعاد' }, base_price: 199, images: ['@asset/prod-standing'] },
      { title: { en: 'Modern Dala Horse in Silver', ar: 'حصان دالا عصري بالفضي' }, base_price: 275, images: ['@asset/prod-dalahorse'] },
      { title: { en: 'Personalized Name Keyring', ar: 'ميدالية مفاتيح بالاسم' }, base_price: 99, images: ['@asset/prod-keyring'] },
      { title: { en: '3D Name Necklace', ar: 'قلادة بالاسم ثلاثية الأبعاد' }, base_price: 390, images: ['@asset/prod-necklace'] },
      { title: { en: 'Personal 3D Name Gift', ar: 'هدية اسم شخصية ثلاثية الأبعاد' }, base_price: 350, images: ['@asset/prod-namekids'] },
      { title: { en: 'Student Plaque — Classic Design', ar: 'لوحة تخرّج — تصميم كلاسيكي' }, base_price: 399, compare_at_price: 600, images: ['@asset/stud-classic'] },
      { title: { en: 'Student Plaque — Soft Design', ar: 'لوحة تخرّج — تصميم ناعم' }, base_price: 399, compare_at_price: 600, images: ['@asset/stud-soft'] },
      { title: { en: 'Student Plaque — Fast Delivery', ar: 'لوحة تخرّج — توصيل سريع' }, base_price: 399, compare_at_price: 600, images: ['@asset/stud-fast'] },
      { title: { en: 'Student Plaque — 2026', ar: 'لوحة تخرّج — 2026' }, base_price: 399, compare_at_price: 900, images: ['@asset/stud-price'] },
    ],
  },
};
