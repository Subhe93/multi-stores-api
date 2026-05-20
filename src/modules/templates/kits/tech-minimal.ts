import { PageType } from '@prisma/client';
import type { Kit } from './types';

// ── Tech — Minimal ──────────────────────────────────────────────
// A clean, product-focused electronics/gadgets storefront kit. Shares the same
// section catalogue as the shoes kit but with a cool blue palette, a video
// section and a specs-forward feel — proving the kit system extends by simply
// adding a data file. Bilingual EN + AR; images use "@asset/<key>".

export const techMinimalKit: Kit = {
  id: 'tech-minimal',
  name: { en: 'Tech — Minimal', ar: 'تقنية — بسيط' },
  description: {
    en: 'A crisp electronics store: punchy hero, feature highlights, a product video, best-sellers and a full product page.',
    ar: 'متجر إلكترونيات أنيق: بانر جذّاب، إبراز المميزات، فيديو للمنتج، الأكثر مبيعاً، وصفحة منتج كاملة.',
  },
  tags: ['electronics', 'gadgets', 'tech', 'retail'],
  previewImage: '@asset/preview',
  themeKey: 'minimal',
  fallbackLocale: 'en',
  // Cool, clean palette: near-black ink with an electric blue accent.
  themeCustomizations: {
    colors: {
      primary: '#0a0a0a',
      secondary: '#1e293b',
      accent: '#2563eb',
      background: '#ffffff',
      surface: '#f1f5f9',
      text: '#0f172a',
      muted: '#64748b',
      border: '#e2e8f0',
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
    'hero-1': { file: 'hero-1.jpg', alt: 'Flagship gadget on a clean backdrop' },
    'gadget-1': { file: 'gadget-1.jpg' },
    'gadget-2': { file: 'gadget-2.jpg' },
    'gadget-3': { file: 'gadget-3.jpg' },
    'gadget-4': { file: 'gadget-4.jpg' },
    'testi-1': { file: 'testi-1.jpg' },
    'testi-2': { file: 'testi-2.jpg' },
  },

  pages: [
    // ── HEADER ──────────────────────────────────────────────
    {
      type: PageType.HEADER,
      sections: [
        {
          section_key: 'announcement-bar',
          settings: { layout: 'simple' },
          content: {
            en: { messages: [{ text: 'Free 2-day shipping · 1-year warranty on all devices' }] },
            ar: { messages: [{ text: 'شحن مجاني خلال يومين · ضمان سنة على كل الأجهزة' }] },
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
              { label: 'Audio', url: '/collections/audio' },
              { label: 'Wearables', url: '/collections/wearables' },
              { label: 'Deals', url: '/collections/deals' },
            ] },
            ar: { items: [
              { label: 'جديد', url: '/products' },
              { label: 'صوتيات', url: '/collections/audio' },
              { label: 'أجهزة ذكية', url: '/collections/wearables' },
              { label: 'عروض', url: '/collections/deals' },
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
          settings: { height: 'lg', overlay_opacity: 0.4, autoplay_ms: 6000, show_arrows: true, show_dots: true, loop: true },
          content: {
            en: { slides: [
              { image: '@asset/hero-1', eyebrow: 'Just launched', heading: 'Tech that keeps up', subheading: 'Powerful, refined, and built to last.', cta_text: 'Shop new', cta_url: '/products', alignment: 'left' },
            ] },
            ar: { slides: [
              { image: '@asset/hero-1', eyebrow: 'وصل حديثاً', heading: 'تقنية تواكبك', subheading: 'قوية، أنيقة، ومصمّمة لتدوم.', cta_text: 'تسوّق الجديد', cta_url: '/products', alignment: 'right' },
            ] },
          },
        },
        {
          section_key: 'feature-grid',
          settings: { columns: 4, alignment: 'center', icon_style: 'chip' },
          content: {
            en: { heading: 'Built for you', items: [
              { icon: 'zap', title: 'Fast charging', description: 'Hours of power in minutes.' },
              { icon: 'shield', title: '1-year warranty', description: 'Covered, every device.' },
              { icon: 'truck', title: 'Free 2-day shipping', description: 'On every order.' },
              { icon: 'headphones', title: 'Expert support', description: 'Real humans, 7 days a week.' },
            ] },
            ar: { heading: 'صُمّم لك', items: [
              { icon: 'zap', title: 'شحن سريع', description: 'ساعات طاقة في دقائق.' },
              { icon: 'shield', title: 'ضمان سنة', description: 'تغطية لكل جهاز.' },
              { icon: 'truck', title: 'شحن مجاني خلال يومين', description: 'على كل طلب.' },
              { icon: 'headphones', title: 'دعم خبير', description: 'بشر حقيقيون، 7 أيام أسبوعياً.' },
            ] },
          },
        },
        {
          section_key: 'featured-products',
          settings: { filter: 'newest', limit: 4, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'New arrivals', subheading: 'The latest, in stock now.', link_label: 'View all', link_url: '/products' },
            ar: { heading: 'وصل حديثاً', subheading: 'الأحدث، متوفّر الآن.', link_label: 'عرض الكل', link_url: '/products' },
          },
        },
        {
          section_key: 'video',
          settings: { video_url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', aspect_ratio: '16/9' },
          content: {
            en: { heading: 'See it in action', subheading: 'A 60-second look at what makes it different.' },
            ar: { heading: 'شاهده أثناء العمل', subheading: 'نظرة في 60 ثانية على ما يميّزه.' },
          },
        },
        {
          section_key: 'collection-products',
          settings: { category: 'gadgets', limit: 8, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'Best sellers', subheading: 'Loved by thousands.', link_label: 'Shop all' },
            ar: { heading: 'الأكثر مبيعاً', subheading: 'محبوب من الآلاف.', link_label: 'تسوّق الكل' },
          },
        },
        {
          section_key: 'stats-bar',
          settings: { style: 'surface', columns: 3 },
          content: {
            en: { items: [
              { value: '4.8', suffix: '/5', label: 'Average rating' },
              { value: '100K', suffix: '+', label: 'Devices shipped' },
              { value: '24', suffix: '/7', label: 'Support' },
            ] },
            ar: { items: [
              { value: '4.8', suffix: '/5', label: 'متوسط التقييم' },
              { value: '100K', suffix: '+', label: 'جهاز تم شحنه' },
              { value: '24', suffix: '/7', label: 'الدعم' },
            ] },
          },
        },
        {
          section_key: 'testimonials',
          settings: { layout: 'cards', columns: 2, show_rating: true },
          content: {
            en: { heading: 'Trusted by tech lovers', items: [
              { quote: 'Setup took two minutes and it just works. Battery life is incredible.', author: 'Omar T.', role: 'Verified buyer', avatar: '@asset/testi-1', rating: 5 },
              { quote: 'Premium build, fair price. The support team is fantastic too.', author: 'Mia R.', role: 'Verified buyer', avatar: '@asset/testi-2', rating: 5 },
            ] },
            ar: { heading: 'موثوق من عشّاق التقنية', items: [
              { quote: 'الإعداد استغرق دقيقتين ويعمل ببساطة. عمر البطارية مذهل.', author: 'عمر ت.', role: 'مشترٍ موثّق', avatar: '@asset/testi-1', rating: 5 },
              { quote: 'تصنيع فاخر وسعر عادل. وفريق الدعم رائع أيضاً.', author: 'ميا ر.', role: 'مشترٍ موثّق', avatar: '@asset/testi-2', rating: 5 },
            ] },
          },
        },
        {
          section_key: 'faq-list',
          settings: { layout: 'two-column', allow_multiple: true },
          content: {
            en: { heading: 'Questions, answered', items: [
              { question: 'What is the warranty?', answer: 'Every device includes a 1-year limited warranty.' },
              { question: 'Do you ship internationally?', answer: 'Yes — to most countries, with tracked delivery.' },
              { question: 'Can I return it?', answer: 'Returns are accepted within 30 days, unused and in original packaging.' },
              { question: 'Is support included?', answer: 'Free expert support, 7 days a week.' },
            ] },
            ar: { heading: 'أسئلة وإجابات', items: [
              { question: 'ما مدة الضمان؟', answer: 'كل جهاز يشمل ضماناً محدوداً لمدة سنة.' },
              { question: 'هل تشحنون دولياً؟', answer: 'نعم — لمعظم الدول، مع شحن متتبَّع.' },
              { question: 'هل يمكنني الإرجاع؟', answer: 'يُقبل الإرجاع خلال 30 يوماً، غير مستخدم وبعبوته الأصلية.' },
              { question: 'هل الدعم مشمول؟', answer: 'دعم خبير مجاني، 7 أيام أسبوعياً.' },
            ] },
          },
        },
        {
          section_key: 'newsletter-signup',
          settings: { style: 'card' },
          content: {
            en: { heading: 'Stay in the loop', subheading: 'New drops and deals, straight to your inbox.', placeholder: 'your@email.com', button_label: 'Subscribe', success_message: 'Subscribed — talk soon!' },
            ar: { heading: 'ابقَ على اطّلاع', subheading: 'إصدارات وعروض جديدة، مباشرة إلى بريدك.', placeholder: 'your@email.com', button_label: 'اشترك', success_message: 'تم الاشتراك — إلى اللقاء!' },
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
                { label: 'Audio', url: '/collections/audio' },
                { label: 'Wearables', url: '/collections/wearables' },
                { label: 'Deals', url: '/collections/deals' },
              ] },
              { heading: 'Support', links: [
                { label: 'Warranty', url: '/pages/warranty' },
                { label: 'Shipping', url: '/pages/shipping' },
                { label: 'Returns', url: '/pages/returns' },
                { label: 'Contact', url: '/pages/contact' },
              ] },
              { heading: 'Company', links: [
                { label: 'About us', url: '/pages/about' },
                { label: 'Press', url: '/pages/press' },
                { label: 'Careers', url: '/pages/careers' },
              ] },
            ] },
            ar: { columns: [
              { heading: 'تسوّق', links: [
                { label: 'وصل حديثاً', url: '/products' },
                { label: 'صوتيات', url: '/collections/audio' },
                { label: 'أجهزة ذكية', url: '/collections/wearables' },
                { label: 'عروض', url: '/collections/deals' },
              ] },
              { heading: 'الدعم', links: [
                { label: 'الضمان', url: '/pages/warranty' },
                { label: 'الشحن', url: '/pages/shipping' },
                { label: 'الإرجاع', url: '/pages/returns' },
                { label: 'تواصل معنا', url: '/pages/contact' },
              ] },
              { heading: 'الشركة', links: [
                { label: 'من نحن', url: '/pages/about' },
                { label: 'الصحافة', url: '/pages/press' },
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
              { platform: 'youtube', url: 'https://youtube.com/' },
              { platform: 'twitter', url: 'https://twitter.com/' },
            ] },
            ar: { heading: 'تابعنا', items: [
              { platform: 'instagram', url: 'https://instagram.com/' },
              { platform: 'youtube', url: 'https://youtube.com/' },
              { platform: 'twitter', url: 'https://twitter.com/' },
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

  demoData: {
    category: {
      slug: 'gadgets',
      translations: [
        { locale: 'en', name: 'Gadgets' },
        { locale: 'ar', name: 'أجهزة' },
      ],
    },
    products: [
      { title: { en: 'Pulse Earbuds', ar: 'سمّاعات بَلس' }, base_price: 79, compare_at_price: 99, images: ['@asset/gadget-1'] },
      { title: { en: 'Vibe Speaker', ar: 'سمّاعة فايب' }, base_price: 129, images: ['@asset/gadget-2'] },
      { title: { en: 'Track Watch', ar: 'ساعة تراك' }, base_price: 159, compare_at_price: 189, images: ['@asset/gadget-3'] },
      { title: { en: 'Charge Pad', ar: 'لوح الشحن' }, base_price: 39, images: ['@asset/gadget-4'] },
    ],
  },
};
