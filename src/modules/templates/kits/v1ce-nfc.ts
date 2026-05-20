import { PageType } from '@prisma/client';
import type { Kit } from './types';

// ── NFC Cards — Premium ─────────────────────────────────────────
// A premium, conversion-focused storefront for NFC / smart business cards,
// styled after v1ce.co: minimalist monochrome, heavyweight metal product
// shots, social proof and a "tap to share" narrative. Composed entirely from
// the existing section catalogue. Bilingual EN + AR; images use "@asset/<key>"
// placeholders resolved to the store's uploads on import (real photos ship in
// assets/templates/v1ce-nfc/, sourced as product/lifestyle reference shots).

export const v1ceNfcKit: Kit = {
  id: 'v1ce-nfc',
  name: { en: 'NFC Cards — Premium', ar: 'بطاقات NFC — فاخر' },
  description: {
    en: 'A sleek, premium storefront for smart NFC business cards: bold monochrome hero, "tap to share" story, metal-card showcase, social proof and a complete product page.',
    ar: 'متجر فاخر وأنيق لبطاقات الأعمال الذكية NFC: بانر أحادي اللون جريء، قصة "انقر لتشارك"، عرض البطاقات المعدنية، دليل اجتماعي، وصفحة منتج كاملة.',
  },
  tags: ['nfc', 'business-cards', 'tech', 'premium', 'minimal'],
  previewImage: '@asset/preview',
  themeKey: 'minimal',
  fallbackLocale: 'en',
  // Premium near-black monochrome with a single electric-blue accent that
  // echoes the blue metal card — reads luxury and modern.
  themeCustomizations: {
    colors: {
      primary: '#0a0a0a',
      secondary: '#262626',
      accent: '#2563eb',
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#0a0a0a',
      muted: '#6b7280',
      border: '#e5e7eb',
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
    preview: { file: 'preview.jpg', alt: 'Black metal NFC business card' },
    'hero-1': { file: 'hero-1.jpg', alt: 'Black stainless steel NFC card with tap symbol' },
    'hero-2': { file: 'hero-2.jpg', alt: 'Blue metal NFC card' },
    'editorial-tap': { file: 'editorial-tap.jpg', alt: 'Hand tapping an NFC card to a phone' },
    'editorial-steel': { file: 'editorial-steel.jpg', alt: 'Heavyweight stainless steel NFC card' },
    'editorial-box': { file: 'editorial-box.jpg', alt: 'NFC card in a premium gift box' },
    'editorial-app': { file: 'editorial-app.jpg', alt: 'Digital profile shared from an NFC card' },
    'gallery-1': { file: 'gallery-1.jpg', alt: 'Black and gold metal card' },
    'gallery-2': { file: 'gallery-2.jpg', alt: 'Blue and silver metal card' },
    'gallery-3': { file: 'gallery-3.jpg', alt: 'Card and phone on a desk' },
    'gallery-4': { file: 'gallery-4.jpg', alt: 'NFC card unboxing' },
    'gallery-5': { file: 'gallery-5.jpg', alt: 'Laser-engraved card detail' },
    'gallery-6': { file: 'gallery-6.jpg', alt: 'Networking event' },
    'avatar-1': { file: 'avatar-1.jpg' },
    'avatar-2': { file: 'avatar-2.jpg' },
    'avatar-3': { file: 'avatar-3.jpg' },
    'avatar-4': { file: 'avatar-4.jpg' },
    'card-black-silver': { file: 'card-black-silver.jpg', alt: 'Black & silver metal NFC card' },
    'card-black-gold': { file: 'card-black-gold.jpg', alt: 'Black & gold metal NFC card' },
    'card-blue-silver': { file: 'card-blue-silver.jpg', alt: 'Blue & silver metal NFC card' },
    'card-engraved': { file: 'card-engraved.jpg', alt: 'Laser-engraved metal NFC card' },
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
              { text: 'Free design service included — revised until you love it' },
              { text: '100% lifetime guarantee · Carbon-neutral shipping', link_label: 'Learn more', link_url: '/pages/guarantee' },
            ] },
            ar: { messages: [
              { text: 'خدمة تصميم مجانية — نعدّلها حتى تعجبك تماماً' },
              { text: 'ضمان مدى الحياة 100% · شحن خالٍ من الكربون', link_label: 'اعرف أكثر', link_url: '/pages/guarantee' },
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
              { label: 'Cards', url: '/products' },
              { label: 'How it works', url: '/pages/how-it-works' },
              { label: 'Reviews', url: '/pages/reviews' },
              { label: 'Pricing', url: '/products' },
            ] },
            ar: { items: [
              { label: 'البطاقات', url: '/products' },
              { label: 'كيف تعمل', url: '/pages/how-it-works' },
              { label: 'التقييمات', url: '/pages/reviews' },
              { label: 'الأسعار', url: '/products' },
            ] },
          },
        },
      ],
    },

    // ── HOME ────────────────────────────────────────────────
    {
      type: PageType.HOME,
      translations: [
        { locale: 'en', title: 'Home', meta_title: 'Smart NFC Business Cards', meta_description: 'Tap to share your contact, links and socials instantly. Premium metal NFC cards — no app required.' },
        { locale: 'ar', title: 'الرئيسية', meta_title: 'بطاقات أعمال NFC ذكية', meta_description: 'انقر لمشاركة جهة اتصالك وروابطك ومواقعك فوراً. بطاقات NFC معدنية فاخرة — دون أي تطبيق.' },
      ],
      sections: [
        {
          section_key: 'hero-slider',
          settings: { height: 'lg', overlay_opacity: 0.5, autoplay_ms: 6000, show_arrows: true, show_dots: true, loop: true },
          content: {
            en: { slides: [
              { image: '@asset/hero-1', eyebrow: 'Smart business cards', heading: 'Turn conversations into clients', subheading: 'One tap shares your details, links and socials straight to their phone — no app required.', cta_text: 'Shop cards', cta_url: '/products', alignment: 'left' },
              { image: '@asset/hero-2', eyebrow: 'Premium metal', heading: 'Make every introduction count', subheading: 'Heavyweight stainless steel, laser-engraved and built to be remembered.', cta_text: 'Explore finishes', cta_url: '/products', alignment: 'center' },
            ] },
            ar: { slides: [
              { image: '@asset/hero-1', eyebrow: 'بطاقات أعمال ذكية', heading: 'حوّل المحادثات إلى عملاء', subheading: 'نقرة واحدة تشارك بياناتك وروابطك ومواقعك مباشرة إلى هاتفهم — دون أي تطبيق.', cta_text: 'تسوّق البطاقات', cta_url: '/products', alignment: 'right' },
              { image: '@asset/hero-2', eyebrow: 'معدن فاخر', heading: 'اجعل كل تعارف ذا قيمة', subheading: 'فولاذ مقاوم للصدأ وزنه ثقيل، محفور بالليزر، وصُمّم ليُتذكَّر.', cta_text: 'اكتشف التشطيبات', cta_url: '/products', alignment: 'center' },
            ] },
          },
        },
        {
          section_key: 'stats-bar',
          settings: { style: 'surface', columns: 3 },
          content: {
            en: { items: [
              { value: '510K', suffix: '+', label: 'Professionals' },
              { value: '43', suffix: '', label: 'Countries' },
              { value: '4.9', suffix: '/5', label: 'Average rating' },
            ] },
            ar: { items: [
              { value: '510K', suffix: '+', label: 'محترف' },
              { value: '43', suffix: '', label: 'دولة' },
              { value: '4.9', suffix: '/5', label: 'متوسط التقييم' },
            ] },
          },
        },
        {
          section_key: 'feature-grid',
          settings: { columns: 4, alignment: 'center', icon_style: 'chip' },
          content: {
            en: { heading: 'Why a smart card', items: [
              { icon: 'card', title: 'One tap to share', description: 'Your full profile, instantly on their phone.' },
              { icon: 'shield', title: 'No app required', description: 'Works on iPhone and Android out of the box.' },
              { icon: 'award', title: 'Premium metal', description: '904L stainless steel, laser-engraved.' },
              { icon: 'leaf', title: 'Eco-friendly', description: 'One card replaces hundreds of paper ones.' },
            ] },
            ar: { heading: 'لماذا بطاقة ذكية', items: [
              { icon: 'card', title: 'نقرة واحدة للمشاركة', description: 'ملفك كاملاً، فوراً على هاتفهم.' },
              { icon: 'shield', title: 'دون تطبيق', description: 'تعمل على آيفون وأندرويد مباشرة.' },
              { icon: 'award', title: 'معدن فاخر', description: 'فولاذ 904L مقاوم للصدأ، محفور بالليزر.' },
              { icon: 'leaf', title: 'صديقة للبيئة', description: 'بطاقة واحدة تغني عن مئات البطاقات الورقية.' },
            ] },
          },
        },
        {
          section_key: 'steps',
          settings: { columns: 3, show_connector: true },
          content: {
            en: { heading: 'How it works', subheading: 'Three taps from hello to saved contact.', items: [
              { title: 'Tap', description: 'Tap your card on any smartphone — no app required.' },
              { title: 'Share', description: 'Your details, links and socials appear instantly.' },
              { title: 'Save', description: 'They save you to their contacts with one click.' },
            ] },
            ar: { heading: 'كيف تعمل', subheading: 'ثلاث نقرات من التحية إلى جهة اتصال محفوظة.', items: [
              { title: 'انقر', description: 'انقر بطاقتك على أي هاتف ذكي — دون أي تطبيق.' },
              { title: 'شارك', description: 'تظهر بياناتك وروابطك ومواقعك فوراً.' },
              { title: 'احفظ', description: 'يحفظونك في جهات اتصالهم بنقرة واحدة.' },
            ] },
          },
        },
        {
          section_key: 'image-with-text',
          settings: { image: '@asset/editorial-tap', image_position: 'right', aspect: 'landscape', cta_url: '/pages/how-it-works' },
          content: {
            en: { eyebrow: 'How it works', heading: 'One tap. Everything shared.', body: 'Tap your card on any smartphone and your contact details, links and socials appear instantly — saved to their address book with a single click. No app, no friction.', cta_text: 'See how it works' },
            ar: { eyebrow: 'كيف تعمل', heading: 'نقرة واحدة. وكل شيء يُشارَك.', body: 'انقر بطاقتك على أي هاتف ذكي فتظهر بياناتك وروابطك ومواقعك فوراً — وتُحفظ في جهات اتصالهم بنقرة واحدة. دون تطبيق ودون عناء.', cta_text: 'شاهد كيف تعمل' },
          },
        },
        {
          section_key: 'featured-products',
          settings: { filter: 'newest', limit: 4, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'Our cards', subheading: 'Choose your finish.', link_label: 'View all', link_url: '/products' },
            ar: { heading: 'بطاقاتنا', subheading: 'اختر تشطيبك.', link_label: 'عرض الكل', link_url: '/products' },
          },
        },
        {
          section_key: 'image-with-text',
          settings: { image: '@asset/editorial-steel', image_position: 'left', aspect: 'landscape', cta_url: '/products' },
          content: {
            en: { eyebrow: 'Built to last', heading: 'Heavyweight stainless steel', body: 'Each card is 904L-grade steel — 25 grams, 1.2mm thick — with softened edges and permanent laser engraving. It feels exactly as serious as you are.', cta_text: 'Shop the metal' },
            ar: { eyebrow: 'صُنعت لتدوم', heading: 'فولاذ مقاوم للصدأ ثقيل الوزن', body: 'كل بطاقة من فولاذ درجة 904L — وزنها 25 غراماً، وسماكتها 1.2 ملم — بحوافٍ ناعمة ونقش ليزر دائم. تبدو بجدّيتك تماماً.', cta_text: 'تسوّق المعدن' },
          },
        },
        {
          section_key: 'comparison-table',
          settings: {},
          content: {
            en: {
              heading: 'Why switch to smart',
              subheading: 'One card that does what paper never could.',
              col_a_label: 'Smart card',
              col_b_label: 'Paper card',
              rows: [
                { feature: 'Share instantly with one tap', a: 'yes', b: 'no' },
                { feature: 'Always up to date', a: 'yes', b: 'no' },
                { feature: 'Never runs out', a: 'yes', b: 'no' },
                { feature: 'Capture their details too', a: 'yes', b: 'no' },
                { feature: 'Eco-friendly', a: 'yes', b: 'no' },
              ],
            },
            ar: {
              heading: 'لماذا الانتقال إلى الذكية',
              subheading: 'بطاقة واحدة تفعل ما لا تستطيعه الورقية أبداً.',
              col_a_label: 'بطاقة ذكية',
              col_b_label: 'بطاقة ورقية',
              rows: [
                { feature: 'مشاركة فورية بنقرة واحدة', a: 'yes', b: 'no' },
                { feature: 'محدّثة دائماً', a: 'yes', b: 'no' },
                { feature: 'لا تنفد أبداً', a: 'yes', b: 'no' },
                { feature: 'تلتقط بياناتهم أيضاً', a: 'yes', b: 'no' },
                { feature: 'صديقة للبيئة', a: 'yes', b: 'no' },
              ],
            },
          },
        },
        {
          section_key: 'collection-products',
          settings: { category: 'nfc-cards', limit: 8, columns: 4, columns_tablet: 3, columns_mobile: 2 },
          content: {
            en: { heading: 'Best sellers', subheading: 'The cards professionals reach for.', link_label: 'Shop the collection' },
            ar: { heading: 'الأكثر مبيعاً', subheading: 'البطاقات التي يختارها المحترفون.', link_label: 'تسوّق المجموعة' },
          },
        },
        {
          section_key: 'trust-badges',
          settings: { layout: 'cards', padding: 'comfortable' },
          content: {
            en: { items: [
              { icon: 'star', label: 'Free design service', description: 'Revised until you approve' },
              { icon: 'shield', label: 'Lifetime guarantee', description: 'Free replacement, for life' },
              { icon: 'card', label: 'Secure checkout', description: 'Encrypted payments' },
              { icon: 'leaf', label: 'Carbon-neutral', description: 'Offset on every order' },
            ] },
            ar: { items: [
              { icon: 'star', label: 'خدمة تصميم مجانية', description: 'نعدّلها حتى توافق' },
              { icon: 'shield', label: 'ضمان مدى الحياة', description: 'استبدال مجاني، مدى الحياة' },
              { icon: 'card', label: 'دفع آمن', description: 'مدفوعات مشفّرة' },
              { icon: 'leaf', label: 'خالٍ من الكربون', description: 'تعويض كربوني لكل طلب' },
            ] },
          },
        },
        {
          section_key: 'testimonials',
          settings: { layout: 'cards', columns: 3, show_rating: true },
          content: {
            en: { heading: 'Trusted by 510,000+ professionals', items: [
              { quote: 'Closed three retainers in October from cards I tapped at one industry dinner.', author: 'Rob Mitchell', role: 'Partnerships Lead', avatar: '@asset/avatar-1', rating: 5 },
              { quote: 'People remember the card before they remember my name. It always starts a conversation.', author: 'Chris Price', role: 'Founder, Stage Engage', avatar: '@asset/avatar-2', rating: 5 },
              { quote: 'First event with a smart card and we captured three times the contacts. Game changer.', author: 'Ignacio Mallagray', role: 'Head of Growth', avatar: '@asset/avatar-3', rating: 5 },
              { quote: 'Premium feel, instant share, zero paper. Exactly the impression I want to leave.', author: 'Olivia K.', role: 'Independent Advisor', avatar: '@asset/avatar-4', rating: 5 },
            ] },
            ar: { heading: 'موثوق به من أكثر من 510,000 محترف', items: [
              { quote: 'أغلقت ثلاثة عقود في أكتوبر من بطاقات نقرتها في عشاء واحد للقطاع.', author: 'روب ميتشل', role: 'مسؤول الشراكات', avatar: '@asset/avatar-1', rating: 5 },
              { quote: 'يتذكّر الناس البطاقة قبل أن يتذكروا اسمي. تبدأ محادثة في كل مرة.', author: 'كريس برايس', role: 'مؤسس Stage Engage', avatar: '@asset/avatar-2', rating: 5 },
              { quote: 'أول فعالية ببطاقة ذكية وجمعنا ثلاثة أضعاف جهات الاتصال. نقلة نوعية.', author: 'إغناسيو مالاغراي', role: 'مدير النمو', avatar: '@asset/avatar-3', rating: 5 },
              { quote: 'إحساس فاخر، مشاركة فورية، وصفر ورق. تماماً الانطباع الذي أريد تركه.', author: 'أوليفيا ك.', role: 'مستشارة مستقلة', avatar: '@asset/avatar-4', rating: 5 },
            ] },
          },
        },
        {
          section_key: 'gallery-slider',
          settings: { slides_per_view: 3, slides_per_view_tablet: 2, slides_per_view_mobile: 1, gap_px: 16, aspect: 'square', show_caption: true, rounded: true, show_arrows: true, show_dots: true },
          content: {
            en: { heading: 'Finishes & in the wild', subheading: 'Eleven finishes. Endless impressions.', items: [
              { url: '@asset/gallery-1', alt: 'Black and gold finish' },
              { url: '@asset/gallery-2', alt: 'Blue and silver finish' },
              { url: '@asset/gallery-3', alt: 'Card and phone' },
              { url: '@asset/gallery-4', alt: 'Premium unboxing' },
              { url: '@asset/gallery-5', alt: 'Laser-engraved detail' },
              { url: '@asset/gallery-6', alt: 'At a networking event' },
            ] },
            ar: { heading: 'التشطيبات وفي الواقع', subheading: 'أحد عشر تشطيباً. انطباعات لا تنتهي.', items: [
              { url: '@asset/gallery-1', alt: 'تشطيب أسود وذهبي' },
              { url: '@asset/gallery-2', alt: 'تشطيب أزرق وفضي' },
              { url: '@asset/gallery-3', alt: 'بطاقة وهاتف' },
              { url: '@asset/gallery-4', alt: 'فتح الصندوق الفاخر' },
              { url: '@asset/gallery-5', alt: 'تفصيل النقش بالليزر' },
              { url: '@asset/gallery-6', alt: 'في فعالية تواصل' },
            ] },
          },
        },
        {
          section_key: 'call-to-action',
          settings: { style: 'split', image: '@asset/editorial-box', cta_url: '/products' },
          content: {
            en: { heading: 'Never lose a lead again', subheading: 'Get your card with a free custom design — proof within 24 hours, revised until you approve.', cta_text: 'Design my card' },
            ar: { heading: 'لا تفقد عميلاً محتملاً مجدداً', subheading: 'احصل على بطاقتك بتصميم مخصّص مجاني — معاينة خلال 24 ساعة، نعدّلها حتى توافق.', cta_text: 'صمّم بطاقتي' },
          },
        },
        {
          section_key: 'faq-list',
          settings: { layout: 'stacked', allow_multiple: true },
          content: {
            en: { heading: 'Frequently asked', items: [
              { question: 'Which phones are compatible?', answer: 'Every modern iPhone and Android phone supports NFC tap-to-share out of the box — no app needed for the person you share with.' },
              { question: 'Do I get help with the design?', answer: 'Yes. A free design service is included with every card — we send a proof within 24 hours and revise it until you approve.' },
              { question: 'Is there a subscription?', answer: 'No. Your card is a one-time purchase with no recurring fees and a 100% lifetime guarantee.' },
              { question: 'How fast is shipping?', answer: 'Cards are made within 48 hours and shipped carbon-neutral from our nearest workshop.' },
            ] },
            ar: { heading: 'الأسئلة الشائعة', items: [
              { question: 'ما الهواتف المتوافقة؟', answer: 'كل هواتف آيفون وأندرويد الحديثة تدعم المشاركة بالنقر NFC مباشرة — دون حاجة لتطبيق لدى من تشاركه.' },
              { question: 'هل تساعدونني في التصميم؟', answer: 'نعم. خدمة تصميم مجانية مع كل بطاقة — نرسل معاينة خلال 24 ساعة ونعدّلها حتى توافق.' },
              { question: 'هل هناك اشتراك؟', answer: 'لا. بطاقتك شراء لمرة واحدة دون رسوم متكررة، مع ضمان مدى الحياة 100%.' },
              { question: 'كم يستغرق الشحن؟', answer: 'تُصنَع البطاقات خلال 48 ساعة وتُشحَن بشكل خالٍ من الكربون من أقرب ورشة لدينا.' },
            ] },
          },
        },
        {
          section_key: 'newsletter-signup',
          settings: { style: 'banner' },
          content: {
            en: { heading: 'Get 10% off your first card', subheading: 'Join our list for launch offers and networking tips.', placeholder: 'your@email.com', button_label: 'Subscribe', success_message: "You're in — check your inbox!" },
            ar: { heading: 'احصل على خصم 10% على أول بطاقة', subheading: 'انضم إلى قائمتنا للعروض ونصائح التواصل المهني.', placeholder: 'your@email.com', button_label: 'اشترك', success_message: 'تم — تفقّد بريدك!' },
          },
        },
        {
          section_key: 'sticky-cta-bar',
          settings: { show_after_px: 600, show_close: true },
          content: {
            en: { text: 'Free custom design · Lifetime guarantee', cta_text: 'Design my card' },
            ar: { text: 'تصميم مخصّص مجاني · ضمان مدى الحياة', cta_text: 'صمّم بطاقتي' },
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
                { label: 'All cards', url: '/products' },
                { label: 'Metal cards', url: '/collections/metal' },
                { label: 'Bundles', url: '/collections/bundles' },
                { label: 'Gift cards', url: '/products' },
              ] },
              { heading: 'Learn', links: [
                { label: 'How it works', url: '/pages/how-it-works' },
                { label: 'Reviews', url: '/pages/reviews' },
                { label: 'Compatibility', url: '/pages/compatibility' },
                { label: 'Contact', url: '/pages/contact' },
              ] },
              { heading: 'Company', links: [
                { label: 'About us', url: '/pages/about' },
                { label: 'Sustainability', url: '/pages/sustainability' },
                { label: 'Lifetime guarantee', url: '/pages/guarantee' },
              ] },
            ] },
            ar: { columns: [
              { heading: 'تسوّق', links: [
                { label: 'كل البطاقات', url: '/products' },
                { label: 'البطاقات المعدنية', url: '/collections/metal' },
                { label: 'الحزم', url: '/collections/bundles' },
                { label: 'بطاقات الهدايا', url: '/products' },
              ] },
              { heading: 'تعلّم', links: [
                { label: 'كيف تعمل', url: '/pages/how-it-works' },
                { label: 'التقييمات', url: '/pages/reviews' },
                { label: 'التوافق', url: '/pages/compatibility' },
                { label: 'تواصل معنا', url: '/pages/contact' },
              ] },
              { heading: 'الشركة', links: [
                { label: 'من نحن', url: '/pages/about' },
                { label: 'الاستدامة', url: '/pages/sustainability' },
                { label: 'ضمان مدى الحياة', url: '/pages/guarantee' },
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
              { platform: 'linkedin', url: 'https://linkedin.com/' },
              { platform: 'tiktok', url: 'https://tiktok.com/' },
              { platform: 'youtube', url: 'https://youtube.com/' },
            ] },
            ar: { heading: 'تابعنا', items: [
              { platform: 'instagram', url: 'https://instagram.com/' },
              { platform: 'linkedin', url: 'https://linkedin.com/' },
              { platform: 'tiktok', url: 'https://tiktok.com/' },
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
      slug: 'nfc-cards',
      translations: [
        { locale: 'en', name: 'NFC Cards' },
        { locale: 'ar', name: 'بطاقات NFC' },
      ],
    },
    products: [
      { title: { en: 'The Metal — Black & Silver', ar: 'ذا ميتال — أسود وفضي' }, base_price: 49, compare_at_price: 69, images: ['@asset/card-black-silver'] },
      { title: { en: 'The Metal — Black & Gold', ar: 'ذا ميتال — أسود وذهبي' }, base_price: 59, images: ['@asset/card-black-gold'] },
      { title: { en: 'The Metal — Blue & Silver', ar: 'ذا ميتال — أزرق وفضي' }, base_price: 49, images: ['@asset/card-blue-silver'] },
      { title: { en: 'The Metal — Engraved Edition', ar: 'ذا ميتال — إصدار محفور' }, base_price: 79, compare_at_price: 99, images: ['@asset/card-engraved'] },
    ],
  },
};
