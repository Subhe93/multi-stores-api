// Bundled wording of the platform onboarding emails (SPEC §5). Admin DB
// templates (NotificationTemplate rows, seeded in en + ar) win when they
// exist; these builders are the fallback in all six locales. Every value is
// escaped before it lands in the HTML, so a phrase must never carry user
// input itself. Tokens: {name} {platform} {store} {store_url} {dashboard_url}
// {support_email} {reason} {company} {hours} {days_left} {email}
// {account_kind} {country} {disposable} {checklist} {verify_url}
// {admin_url} {review_url}.

import { esc, layoutEmail, emailButton, type EmailParts } from './templates';

export const ONBOARDING_EVENTS = [
  'email_verification',
  'welcome_owner',
  'welcome_supplier',
  'verify_reminder',
  'golive_requested',
  'store_live',
  'store_changes_requested',
  'store_suspended',
  'supplier_approved',
  'admin_new_signup',
  'admin_golive_request',
] as const;
export type OnboardingEvent = (typeof ONBOARDING_EVENTS)[number];

/** Variables each event is rendered with (DB template placeholders too). */
export const ONBOARDING_EVENT_VARIABLES: Record<OnboardingEvent, string[]> = {
  email_verification: ['platform_name', 'name', 'verify_url', 'expires_hours'],
  welcome_owner: ['platform_name', 'name', 'dashboard_url', 'support_email'],
  welcome_supplier: [
    'platform_name',
    'name',
    'company_name',
    'dashboard_url',
    'support_email',
  ],
  verify_reminder: ['platform_name', 'name', 'verify_url', 'days_left'],
  golive_requested: ['platform_name', 'name', 'store_name', 'dashboard_url'],
  store_live: [
    'platform_name',
    'name',
    'store_name',
    'store_url',
    'dashboard_url',
  ],
  store_changes_requested: [
    'platform_name',
    'name',
    'store_name',
    'reason',
    'dashboard_url',
  ],
  store_suspended: [
    'platform_name',
    'name',
    'store_name',
    'reason',
    'support_email',
  ],
  supplier_approved: ['platform_name', 'name', 'company_name', 'dashboard_url'],
  admin_new_signup: [
    'platform_name',
    'email',
    'name',
    'account_kind',
    'country',
    'disposable',
    'admin_url',
  ],
  admin_golive_request: [
    'platform_name',
    'store_name',
    'store_slug',
    'owner_email',
    'checklist',
    'review_url',
  ],
};

/** Which variable the call-to-action button links to, per event. */
const BUTTON_URL_VAR: Partial<Record<OnboardingEvent, string>> = {
  email_verification: 'verify_url',
  welcome_owner: 'dashboard_url',
  welcome_supplier: 'dashboard_url',
  verify_reminder: 'verify_url',
  golive_requested: 'dashboard_url',
  store_live: 'store_url',
  store_changes_requested: 'dashboard_url',
  supplier_approved: 'dashboard_url',
  admin_new_signup: 'admin_url',
  admin_golive_request: 'review_url',
};

interface Phrases {
  subject: string;
  title: string;
  /** Paragraphs; `{token}` placeholders. */
  body: string[];
  button?: string;
  /** Small print under the button. */
  footer?: string;
}

type Locales = Record<string, Phrases>;

export const ONBOARDING_TEXT: Record<OnboardingEvent, Locales> = {
  email_verification: {
    en: {
      subject: 'Verify your email for {platform}',
      title: 'Verify your email address',
      body: [
        'Hi {name},',
        'Thanks for signing up to {platform}. Confirm your email address to unlock publishing, payments and the rest of your account. The link is valid for {hours} hours and can be used once.',
      ],
      button: 'Verify email',
      footer: 'If you did not create this account, you can ignore this email.',
    },
    sv: {
      subject: 'Bekräfta din e-post hos {platform}',
      title: 'Bekräfta din e-postadress',
      body: [
        'Hej {name},',
        'Tack för att du registrerade dig hos {platform}. Bekräfta din e-postadress för att låsa upp publicering, betalningar och resten av ditt konto. Länken gäller i {hours} timmar och kan användas en gång.',
      ],
      button: 'Bekräfta e-post',
      footer: 'Om du inte skapade det här kontot kan du bortse från mejlet.',
    },
    ar: {
      subject: 'تأكيد بريدك الإلكتروني في {platform}',
      title: 'أكّد عنوان بريدك الإلكتروني',
      body: [
        'مرحباً {name}،',
        'شكراً لتسجيلك في {platform}. أكّد عنوان بريدك الإلكتروني لتفعيل النشر والمدفوعات وبقية مزايا حسابك. الرابط صالح لمدة {hours} ساعة ويُستخدم مرة واحدة.',
      ],
      button: 'تأكيد البريد',
      footer: 'إذا لم تقم بإنشاء هذا الحساب، يمكنك تجاهل هذه الرسالة.',
    },
    de: {
      subject: 'Bestätigen Sie Ihre E-Mail bei {platform}',
      title: 'E-Mail-Adresse bestätigen',
      body: [
        'Hallo {name},',
        'danke für Ihre Registrierung bei {platform}. Bestätigen Sie Ihre E-Mail-Adresse, um Veröffentlichung, Zahlungen und den Rest Ihres Kontos freizuschalten. Der Link ist {hours} Stunden gültig und kann einmal verwendet werden.',
      ],
      button: 'E-Mail bestätigen',
      footer:
        'Wenn Sie dieses Konto nicht erstellt haben, können Sie diese E-Mail ignorieren.',
    },
    fr: {
      subject: 'Vérifiez votre e-mail pour {platform}',
      title: 'Vérifiez votre adresse e-mail',
      body: [
        'Bonjour {name},',
        'Merci de votre inscription sur {platform}. Confirmez votre adresse e-mail pour débloquer la publication, les paiements et le reste de votre compte. Le lien est valable {hours} heures et ne peut être utilisé qu’une fois.',
      ],
      button: 'Vérifier l’e-mail',
      footer:
        'Si vous n’avez pas créé ce compte, vous pouvez ignorer cet e-mail.',
    },
    tr: {
      subject: '{platform} için e-postanızı doğrulayın',
      title: 'E-posta adresinizi doğrulayın',
      body: [
        'Merhaba {name},',
        '{platform} üzerinde kayıt olduğunuz için teşekkürler. Yayınlama, ödemeler ve hesabınızın geri kalanını açmak için e-posta adresinizi doğrulayın. Bağlantı {hours} saat geçerlidir ve bir kez kullanılabilir.',
      ],
      button: 'E-postayı doğrula',
      footer:
        'Bu hesabı siz oluşturmadıysanız bu e-postayı dikkate almayabilirsiniz.',
    },
  },
  welcome_owner: {
    en: {
      subject: 'Welcome to {platform} — your next steps',
      title: 'Your email is verified',
      body: [
        'Hi {name},',
        'Your {platform} account is ready. Three steps take your store live:',
        '1. Create your store (name, address and language).',
        '2. Add your first product.',
        '3. Fill in your trader details and request go-live.',
        'Questions? Write to {support_email}.',
      ],
      button: 'Open the dashboard',
    },
    sv: {
      subject: 'Välkommen till {platform} – dina nästa steg',
      title: 'Din e-post är bekräftad',
      body: [
        'Hej {name},',
        'Ditt konto hos {platform} är klart. Tre steg tar din butik live:',
        '1. Skapa din butik (namn, adress och språk).',
        '2. Lägg till din första produkt.',
        '3. Fyll i dina företagsuppgifter och begär publicering.',
        'Frågor? Skriv till {support_email}.',
      ],
      button: 'Öppna kontrollpanelen',
    },
    ar: {
      subject: 'أهلاً بك في {platform} — خطواتك التالية',
      title: 'تم تأكيد بريدك الإلكتروني',
      body: [
        'مرحباً {name}،',
        'حسابك في {platform} جاهز. ثلاث خطوات تجعل متجرك مباشراً:',
        '1. أنشئ متجرك (الاسم والعنوان واللغة).',
        '2. أضف أول منتج.',
        '3. أكمل بيانات التاجر واطلب النشر.',
        'لديك سؤال؟ راسلنا على {support_email}.',
      ],
      button: 'فتح لوحة التحكم',
    },
    de: {
      subject: 'Willkommen bei {platform} – Ihre nächsten Schritte',
      title: 'Ihre E-Mail ist bestätigt',
      body: [
        'Hallo {name},',
        'Ihr Konto bei {platform} ist bereit. Drei Schritte bringen Ihren Shop online:',
        '1. Shop anlegen (Name, Adresse und Sprache).',
        '2. Erstes Produkt hinzufügen.',
        '3. Händlerangaben ausfüllen und Freischaltung anfordern.',
        'Fragen? Schreiben Sie an {support_email}.',
      ],
      button: 'Dashboard öffnen',
    },
    fr: {
      subject: 'Bienvenue sur {platform} — vos prochaines étapes',
      title: 'Votre e-mail est vérifié',
      body: [
        'Bonjour {name},',
        'Votre compte {platform} est prêt. Trois étapes mettent votre boutique en ligne :',
        '1. Créez votre boutique (nom, adresse et langue).',
        '2. Ajoutez votre premier produit.',
        '3. Renseignez vos informations légales et demandez la mise en ligne.',
        'Des questions ? Écrivez à {support_email}.',
      ],
      button: 'Ouvrir le tableau de bord',
    },
    tr: {
      subject: '{platform}’a hoş geldiniz — sonraki adımlarınız',
      title: 'E-postanız doğrulandı',
      body: [
        'Merhaba {name},',
        '{platform} hesabınız hazır. Üç adımda mağazanız yayına girer:',
        '1. Mağazanızı oluşturun (ad, adres ve dil).',
        '2. İlk ürününüzü ekleyin.',
        '3. Satıcı bilgilerinizi doldurun ve yayına alma talebi gönderin.',
        'Sorunuz mu var? {support_email} adresine yazın.',
      ],
      button: 'Paneli aç',
    },
  },
  welcome_supplier: {
    en: {
      subject: 'Welcome to {platform} as a supplier',
      title: 'Your supplier account is ready',
      body: [
        'Hi {name},',
        'Your email is verified and {company} now has a supplier account at {platform}. Add your products from the dashboard; they appear in the creator catalog as soon as our team has approved your account.',
        'Questions? Write to {support_email}.',
      ],
      button: 'Open the dashboard',
    },
    sv: {
      subject: 'Välkommen till {platform} som leverantör',
      title: 'Ditt leverantörskonto är klart',
      body: [
        'Hej {name},',
        'Din e-post är bekräftad och {company} har nu ett leverantörskonto hos {platform}. Lägg till dina produkter i kontrollpanelen; de visas i kreatörskatalogen så snart vårt team har godkänt ditt konto.',
        'Frågor? Skriv till {support_email}.',
      ],
      button: 'Öppna kontrollpanelen',
    },
    ar: {
      subject: 'أهلاً بك في {platform} كمورّد',
      title: 'حساب المورّد جاهز',
      body: [
        'مرحباً {name}،',
        'تم تأكيد بريدك الإلكتروني وأصبح لدى {company} حساب مورّد في {platform}. أضف منتجاتك من لوحة التحكم؛ ستظهر في كتالوج المبدعين فور موافقة فريقنا على حسابك.',
        'لديك سؤال؟ راسلنا على {support_email}.',
      ],
      button: 'فتح لوحة التحكم',
    },
    de: {
      subject: 'Willkommen bei {platform} als Lieferant',
      title: 'Ihr Lieferantenkonto ist bereit',
      body: [
        'Hallo {name},',
        'Ihre E-Mail ist bestätigt und {company} hat jetzt ein Lieferantenkonto bei {platform}. Fügen Sie Ihre Produkte im Dashboard hinzu; sie erscheinen im Creator-Katalog, sobald unser Team Ihr Konto freigegeben hat.',
        'Fragen? Schreiben Sie an {support_email}.',
      ],
      button: 'Dashboard öffnen',
    },
    fr: {
      subject: 'Bienvenue sur {platform} en tant que fournisseur',
      title: 'Votre compte fournisseur est prêt',
      body: [
        'Bonjour {name},',
        'Votre e-mail est vérifié et {company} dispose désormais d’un compte fournisseur sur {platform}. Ajoutez vos produits depuis le tableau de bord ; ils apparaîtront dans le catalogue des créateurs dès que notre équipe aura approuvé votre compte.',
        'Des questions ? Écrivez à {support_email}.',
      ],
      button: 'Ouvrir le tableau de bord',
    },
    tr: {
      subject: 'Tedarikçi olarak {platform}’a hoş geldiniz',
      title: 'Tedarikçi hesabınız hazır',
      body: [
        'Merhaba {name},',
        'E-postanız doğrulandı ve {company} artık {platform} üzerinde bir tedarikçi hesabına sahip. Ürünlerinizi panelden ekleyin; ekibimiz hesabınızı onayladığı anda içerik üretici kataloğunda görünürler.',
        'Sorunuz mu var? {support_email} adresine yazın.',
      ],
      button: 'Paneli aç',
    },
  },
  verify_reminder: {
    en: {
      subject: 'Reminder: verify your email for {platform}',
      title: 'Your email is still unverified',
      body: [
        'Hi {name},',
        'Your {platform} account still needs a verified email address. You have {days_left} days left before publishing and other actions are locked until you verify.',
      ],
      button: 'Verify email',
      footer: 'If you did not create this account, you can ignore this email.',
    },
    sv: {
      subject: 'Påminnelse: bekräfta din e-post hos {platform}',
      title: 'Din e-post är fortfarande obekräftad',
      body: [
        'Hej {name},',
        'Ditt konto hos {platform} behöver fortfarande en bekräftad e-postadress. Du har {days_left} dagar kvar innan publicering och andra åtgärder låses tills du bekräftar.',
      ],
      button: 'Bekräfta e-post',
      footer: 'Om du inte skapade det här kontot kan du bortse från mejlet.',
    },
    ar: {
      subject: 'تذكير: أكّد بريدك الإلكتروني في {platform}',
      title: 'بريدك الإلكتروني لم يُؤكَّد بعد',
      body: [
        'مرحباً {name}،',
        'ما زال حسابك في {platform} بحاجة إلى تأكيد البريد الإلكتروني. تبقّى لديك {days_left} أيام قبل أن يُقفل النشر وبقية الإجراءات حتى تؤكد بريدك.',
      ],
      button: 'تأكيد البريد',
      footer: 'إذا لم تقم بإنشاء هذا الحساب، يمكنك تجاهل هذه الرسالة.',
    },
    de: {
      subject: 'Erinnerung: E-Mail bei {platform} bestätigen',
      title: 'Ihre E-Mail ist noch nicht bestätigt',
      body: [
        'Hallo {name},',
        'Ihr Konto bei {platform} braucht noch eine bestätigte E-Mail-Adresse. Sie haben noch {days_left} Tage, bevor Veröffentlichung und andere Aktionen bis zur Bestätigung gesperrt werden.',
      ],
      button: 'E-Mail bestätigen',
      footer:
        'Wenn Sie dieses Konto nicht erstellt haben, können Sie diese E-Mail ignorieren.',
    },
    fr: {
      subject: 'Rappel : vérifiez votre e-mail pour {platform}',
      title: 'Votre e-mail n’est pas encore vérifié',
      body: [
        'Bonjour {name},',
        'Votre compte {platform} a toujours besoin d’une adresse e-mail vérifiée. Il vous reste {days_left} jours avant que la publication et d’autres actions soient bloquées jusqu’à la vérification.',
      ],
      button: 'Vérifier l’e-mail',
      footer:
        'Si vous n’avez pas créé ce compte, vous pouvez ignorer cet e-mail.',
    },
    tr: {
      subject: 'Hatırlatma: {platform} için e-postanızı doğrulayın',
      title: 'E-postanız hâlâ doğrulanmadı',
      body: [
        'Merhaba {name},',
        '{platform} hesabınız hâlâ doğrulanmış bir e-posta adresine ihtiyaç duyuyor. Yayınlama ve diğer işlemler kilitlenmeden önce {days_left} gününüz kaldı.',
      ],
      button: 'E-postayı doğrula',
      footer:
        'Bu hesabı siz oluşturmadıysanız bu e-postayı dikkate almayabilirsiniz.',
    },
  },
  golive_requested: {
    en: {
      subject: 'We received your go-live request for {store}',
      title: 'Your store is under review',
      body: [
        'Hi {name},',
        'Thanks for requesting go-live for {store}. Our team reviews new stores usually within one business day. You can keep editing products, pages and settings in the meantime.',
      ],
      button: 'Open the dashboard',
    },
    sv: {
      subject: 'Vi har tagit emot din begäran om publicering för {store}',
      title: 'Din butik granskas',
      body: [
        'Hej {name},',
        'Tack för din begäran om att publicera {store}. Vårt team granskar nya butiker vanligtvis inom en arbetsdag. Du kan fortsätta redigera produkter, sidor och inställningar under tiden.',
      ],
      button: 'Öppna kontrollpanelen',
    },
    ar: {
      subject: 'استلمنا طلب نشر متجرك {store}',
      title: 'متجرك قيد المراجعة',
      body: [
        'مرحباً {name}،',
        'شكراً لطلبك نشر {store}. يراجع فريقنا المتاجر الجديدة عادةً خلال يوم عمل واحد. يمكنك مواصلة تعديل المنتجات والصفحات والإعدادات في هذه الأثناء.',
      ],
      button: 'فتح لوحة التحكم',
    },
    de: {
      subject: 'Ihre Freischaltungsanfrage für {store} ist eingegangen',
      title: 'Ihr Shop wird geprüft',
      body: [
        'Hallo {name},',
        'danke für Ihre Freischaltungsanfrage für {store}. Unser Team prüft neue Shops in der Regel innerhalb eines Werktags. Produkte, Seiten und Einstellungen können Sie währenddessen weiter bearbeiten.',
      ],
      button: 'Dashboard öffnen',
    },
    fr: {
      subject: 'Nous avons reçu votre demande de mise en ligne pour {store}',
      title: 'Votre boutique est en cours de vérification',
      body: [
        'Bonjour {name},',
        'Merci d’avoir demandé la mise en ligne de {store}. Notre équipe examine les nouvelles boutiques généralement sous un jour ouvré. Vous pouvez continuer à modifier produits, pages et paramètres entre-temps.',
      ],
      button: 'Ouvrir le tableau de bord',
    },
    tr: {
      subject: '{store} için yayına alma talebinizi aldık',
      title: 'Mağazanız inceleniyor',
      body: [
        'Merhaba {name},',
        '{store} için yayına alma talebiniz için teşekkürler. Ekibimiz yeni mağazaları genellikle bir iş günü içinde inceler. Bu arada ürünleri, sayfaları ve ayarları düzenlemeye devam edebilirsiniz.',
      ],
      button: 'Paneli aç',
    },
  },
  store_live: {
    en: {
      subject: '{store} is live',
      title: 'Your store is live',
      body: [
        'Hi {name},',
        '{store} is now public at {store_url}. Next steps: share the link, connect your payment provider if you have not yet, and keep adding products.',
      ],
      button: 'Visit your store',
    },
    sv: {
      subject: '{store} är live',
      title: 'Din butik är live',
      body: [
        'Hej {name},',
        '{store} är nu publik på {store_url}. Nästa steg: dela länken, koppla din betalleverantör om du inte redan gjort det och fortsätt lägga till produkter.',
      ],
      button: 'Besök din butik',
    },
    ar: {
      subject: 'متجرك {store} أصبح مباشراً',
      title: 'متجرك مباشر الآن',
      body: [
        'مرحباً {name}،',
        'أصبح {store} متاحاً للعموم على {store_url}. الخطوات التالية: شارك الرابط، واربط مزوّد الدفع إن لم تفعل بعد، وواصل إضافة المنتجات.',
      ],
      button: 'زيارة متجرك',
    },
    de: {
      subject: '{store} ist online',
      title: 'Ihr Shop ist online',
      body: [
        'Hallo {name},',
        '{store} ist jetzt öffentlich unter {store_url}. Nächste Schritte: Link teilen, Zahlungsanbieter verbinden (falls noch nicht geschehen) und weitere Produkte anlegen.',
      ],
      button: 'Shop besuchen',
    },
    fr: {
      subject: '{store} est en ligne',
      title: 'Votre boutique est en ligne',
      body: [
        'Bonjour {name},',
        '{store} est maintenant public à l’adresse {store_url}. Prochaines étapes : partagez le lien, connectez votre prestataire de paiement si ce n’est pas déjà fait et continuez à ajouter des produits.',
      ],
      button: 'Voir votre boutique',
    },
    tr: {
      subject: '{store} yayında',
      title: 'Mağazanız yayında',
      body: [
        'Merhaba {name},',
        '{store} artık {store_url} adresinde herkese açık. Sonraki adımlar: bağlantıyı paylaşın, henüz yapmadıysanız ödeme sağlayıcınızı bağlayın ve ürün eklemeye devam edin.',
      ],
      button: 'Mağazanızı ziyaret edin',
    },
  },
  store_changes_requested: {
    en: {
      subject: 'Changes requested for {store}',
      title: 'Your store needs a few changes',
      body: [
        'Hi {name},',
        'We reviewed {store} and need the following before it can go live:',
        '{reason}',
        'Make the changes in the dashboard and request go-live again.',
      ],
      button: 'Open the dashboard',
    },
    sv: {
      subject: 'Ändringar begärda för {store}',
      title: 'Din butik behöver några ändringar',
      body: [
        'Hej {name},',
        'Vi har granskat {store} och behöver följande innan den kan publiceras:',
        '{reason}',
        'Gör ändringarna i kontrollpanelen och begär publicering igen.',
      ],
      button: 'Öppna kontrollpanelen',
    },
    ar: {
      subject: 'مطلوب تعديلات على {store}',
      title: 'متجرك بحاجة إلى بعض التعديلات',
      body: [
        'مرحباً {name}،',
        'راجعنا {store} ونحتاج إلى ما يلي قبل نشره:',
        '{reason}',
        'أجرِ التعديلات من لوحة التحكم ثم اطلب النشر مجدداً.',
      ],
      button: 'فتح لوحة التحكم',
    },
    de: {
      subject: 'Änderungen für {store} erforderlich',
      title: 'Ihr Shop braucht ein paar Änderungen',
      body: [
        'Hallo {name},',
        'wir haben {store} geprüft und brauchen Folgendes vor der Freischaltung:',
        '{reason}',
        'Nehmen Sie die Änderungen im Dashboard vor und fordern Sie die Freischaltung erneut an.',
      ],
      button: 'Dashboard öffnen',
    },
    fr: {
      subject: 'Modifications demandées pour {store}',
      title: 'Votre boutique nécessite quelques modifications',
      body: [
        'Bonjour {name},',
        'Nous avons examiné {store} et avons besoin de ce qui suit avant sa mise en ligne :',
        '{reason}',
        'Apportez les modifications dans le tableau de bord puis redemandez la mise en ligne.',
      ],
      button: 'Ouvrir le tableau de bord',
    },
    tr: {
      subject: '{store} için değişiklik istendi',
      title: 'Mağazanızda birkaç değişiklik gerekiyor',
      body: [
        'Merhaba {name},',
        '{store} mağazasını inceledik; yayına alınmadan önce şunlar gerekiyor:',
        '{reason}',
        'Değişiklikleri panelden yapın ve yeniden yayına alma talebi gönderin.',
      ],
      button: 'Paneli aç',
    },
  },
  store_suspended: {
    en: {
      subject: '{store} has been suspended',
      title: 'Your store is suspended',
      body: [
        'Hi {name},',
        '{store} is no longer public. Reason:',
        '{reason}',
        'If you think this is a mistake, write to {support_email}.',
      ],
    },
    sv: {
      subject: '{store} har stängts av',
      title: 'Din butik är avstängd',
      body: [
        'Hej {name},',
        '{store} är inte längre publik. Anledning:',
        '{reason}',
        'Om du tror att detta är ett misstag, skriv till {support_email}.',
      ],
    },
    ar: {
      subject: 'تم تعليق متجرك {store}',
      title: 'متجرك معلّق',
      body: [
        'مرحباً {name}،',
        'لم يعد {store} متاحاً للعموم. السبب:',
        '{reason}',
        'إذا كنت تعتقد أن هذا خطأ، راسلنا على {support_email}.',
      ],
    },
    de: {
      subject: '{store} wurde gesperrt',
      title: 'Ihr Shop ist gesperrt',
      body: [
        'Hallo {name},',
        '{store} ist nicht mehr öffentlich. Grund:',
        '{reason}',
        'Wenn Sie das für einen Fehler halten, schreiben Sie an {support_email}.',
      ],
    },
    fr: {
      subject: '{store} a été suspendue',
      title: 'Votre boutique est suspendue',
      body: [
        'Bonjour {name},',
        '{store} n’est plus publique. Motif :',
        '{reason}',
        'Si vous pensez qu’il s’agit d’une erreur, écrivez à {support_email}.',
      ],
    },
    tr: {
      subject: '{store} askıya alındı',
      title: 'Mağazanız askıya alındı',
      body: [
        'Merhaba {name},',
        '{store} artık herkese açık değil. Neden:',
        '{reason}',
        'Bunun bir hata olduğunu düşünüyorsanız {support_email} adresine yazın.',
      ],
    },
  },
  supplier_approved: {
    en: {
      subject: '{company} is approved on {platform}',
      title: 'Your supplier account is approved',
      body: [
        'Hi {name},',
        '{company} is now a verified supplier on {platform}. Your published products are listed in the creator catalog from now on.',
      ],
      button: 'Open the dashboard',
    },
    sv: {
      subject: '{company} är godkänd på {platform}',
      title: 'Ditt leverantörskonto är godkänt',
      body: [
        'Hej {name},',
        '{company} är nu en verifierad leverantör på {platform}. Dina publicerade produkter visas från och med nu i kreatörskatalogen.',
      ],
      button: 'Öppna kontrollpanelen',
    },
    ar: {
      subject: 'تمت الموافقة على {company} في {platform}',
      title: 'تمت الموافقة على حساب المورّد',
      body: [
        'مرحباً {name}،',
        'أصبح {company} مورّداً موثقاً في {platform}. ستُعرض منتجاتك المنشورة في كتالوج المبدعين من الآن.',
      ],
      button: 'فتح لوحة التحكم',
    },
    de: {
      subject: '{company} ist auf {platform} freigegeben',
      title: 'Ihr Lieferantenkonto ist freigegeben',
      body: [
        'Hallo {name},',
        '{company} ist jetzt ein verifizierter Lieferant auf {platform}. Ihre veröffentlichten Produkte erscheinen ab sofort im Creator-Katalog.',
      ],
      button: 'Dashboard öffnen',
    },
    fr: {
      subject: '{company} est approuvé sur {platform}',
      title: 'Votre compte fournisseur est approuvé',
      body: [
        'Bonjour {name},',
        '{company} est désormais un fournisseur vérifié sur {platform}. Vos produits publiés figurent dès maintenant dans le catalogue des créateurs.',
      ],
      button: 'Ouvrir le tableau de bord',
    },
    tr: {
      subject: '{company}, {platform} üzerinde onaylandı',
      title: 'Tedarikçi hesabınız onaylandı',
      body: [
        'Merhaba {name},',
        '{company} artık {platform} üzerinde doğrulanmış bir tedarikçi. Yayınlanan ürünleriniz bundan sonra içerik üretici kataloğunda listelenir.',
      ],
      button: 'Paneli aç',
    },
  },
  admin_new_signup: {
    en: {
      subject: 'New sign-up: {email} ({account_kind})',
      title: 'New account on {platform}',
      body: [
        'Email: {email}',
        'Name: {name}',
        'Account kind: {account_kind}',
        'Country: {country}',
        'Disposable email domain: {disposable}',
      ],
      button: 'Open in admin',
    },
    sv: {
      subject: 'Ny registrering: {email} ({account_kind})',
      title: 'Nytt konto på {platform}',
      body: [
        'E-post: {email}',
        'Namn: {name}',
        'Kontotyp: {account_kind}',
        'Land: {country}',
        'Engångsdomän: {disposable}',
      ],
      button: 'Öppna i admin',
    },
    ar: {
      subject: 'تسجيل جديد: {email} ({account_kind})',
      title: 'حساب جديد في {platform}',
      body: [
        'البريد الإلكتروني: {email}',
        'الاسم: {name}',
        'نوع الحساب: {account_kind}',
        'الدولة: {country}',
        'نطاق بريد مؤقت: {disposable}',
      ],
      button: 'فتح في لوحة الإدارة',
    },
    de: {
      subject: 'Neue Registrierung: {email} ({account_kind})',
      title: 'Neues Konto auf {platform}',
      body: [
        'E-Mail: {email}',
        'Name: {name}',
        'Kontotyp: {account_kind}',
        'Land: {country}',
        'Wegwerf-Domain: {disposable}',
      ],
      button: 'Im Admin öffnen',
    },
    fr: {
      subject: 'Nouvelle inscription : {email} ({account_kind})',
      title: 'Nouveau compte sur {platform}',
      body: [
        'E-mail : {email}',
        'Nom : {name}',
        'Type de compte : {account_kind}',
        'Pays : {country}',
        'Domaine jetable : {disposable}',
      ],
      button: 'Ouvrir dans l’admin',
    },
    tr: {
      subject: 'Yeni kayıt: {email} ({account_kind})',
      title: '{platform} üzerinde yeni hesap',
      body: [
        'E-posta: {email}',
        'Ad: {name}',
        'Hesap türü: {account_kind}',
        'Ülke: {country}',
        'Geçici e-posta alanı: {disposable}',
      ],
      button: 'Yönetimde aç',
    },
  },
  admin_golive_request: {
    en: {
      subject: 'Go-live request: {store}',
      title: 'A store is waiting for review',
      body: [
        'Store: {store} ({store_slug})',
        'Owner: {owner_email}',
        'Checklist: {checklist}',
      ],
      button: 'Review the store',
    },
    sv: {
      subject: 'Begäran om publicering: {store}',
      title: 'En butik väntar på granskning',
      body: [
        'Butik: {store} ({store_slug})',
        'Ägare: {owner_email}',
        'Checklista: {checklist}',
      ],
      button: 'Granska butiken',
    },
    ar: {
      subject: 'طلب نشر: {store}',
      title: 'متجر بانتظار المراجعة',
      body: [
        'المتجر: {store} ({store_slug})',
        'المالك: {owner_email}',
        'قائمة التحقق: {checklist}',
      ],
      button: 'مراجعة المتجر',
    },
    de: {
      subject: 'Freischaltungsanfrage: {store}',
      title: 'Ein Shop wartet auf Prüfung',
      body: [
        'Shop: {store} ({store_slug})',
        'Inhaber: {owner_email}',
        'Checkliste: {checklist}',
      ],
      button: 'Shop prüfen',
    },
    fr: {
      subject: 'Demande de mise en ligne : {store}',
      title: 'Une boutique attend une vérification',
      body: [
        'Boutique : {store} ({store_slug})',
        'Propriétaire : {owner_email}',
        'Liste de contrôle : {checklist}',
      ],
      button: 'Vérifier la boutique',
    },
    tr: {
      subject: 'Yayına alma talebi: {store}',
      title: 'Bir mağaza inceleme bekliyor',
      body: [
        'Mağaza: {store} ({store_slug})',
        'Sahibi: {owner_email}',
        'Kontrol listesi: {checklist}',
      ],
      button: 'Mağazayı incele',
    },
  },
};

/** Split/join token fill, so `$` patterns in values stay literal. */
function fill(phrase: string, tokens: Record<string, string>): string {
  return Object.entries(tokens).reduce(
    (out, [key, value]) => out.split(`{${key}}`).join(value),
    phrase,
  );
}

/** Map the send-time variables (snake_case) onto the phrase tokens. */
function tokensOf(vars: Record<string, string>): Record<string, string> {
  return {
    platform: vars.platform_name ?? '',
    name: vars.name ?? '',
    store: vars.store_name ?? '',
    store_slug: vars.store_slug ?? '',
    store_url: vars.store_url ?? '',
    dashboard_url: vars.dashboard_url ?? '',
    support_email: vars.support_email ?? '',
    reason: vars.reason ?? '',
    company: vars.company_name ?? '',
    hours: vars.expires_hours ?? '',
    days_left: vars.days_left ?? '',
    email: vars.email ?? '',
    owner_email: vars.owner_email ?? '',
    account_kind: vars.account_kind ?? '',
    country: vars.country ?? '',
    disposable: vars.disposable ?? '',
    checklist: vars.checklist ?? '',
    verify_url: vars.verify_url ?? '',
    admin_url: vars.admin_url ?? '',
    review_url: vars.review_url ?? '',
  };
}

/** The locale key the bundled wording exists for ('en' fallback). */
export function onboardingLocale(locale?: string | null): string {
  const key = (locale ?? 'en').toLowerCase().split(/[-_]/)[0];
  return ONBOARDING_TEXT.email_verification[key] ? key : 'en';
}

/**
 * Bundled email of an onboarding event. Values are escaped in the HTML;
 * the text part carries them raw. Arabic renders right-to-left.
 */
export function onboardingEmail(
  event: OnboardingEvent,
  vars: Record<string, string>,
  locale?: string | null,
  brand?: { platformName?: string },
): EmailParts {
  const lang = onboardingLocale(locale);
  const t = ONBOARDING_TEXT[event][lang];
  const raw = tokensOf(vars);
  const html = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, esc(v)]),
  );
  const urlVar = BUTTON_URL_VAR[event];
  const url = urlVar ? (vars[urlVar] ?? '') : '';
  const p = 'font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 12px;';
  const small = 'font-size:12px;line-height:1.6;color:#71717a;margin:12px 0 0;';
  const paragraphs = t.body
    .map((line) => `<p style="${p}">${fill(line, html)}</p>`)
    .join('\n');
  const cta =
    t.button && url
      ? `<p style="margin:20px 0 0;">${emailButton(t.button, url)}</p>`
      : '';
  const footer = t.footer ? `<p style="${small}">${esc(t.footer)}</p>` : '';
  const text = [
    ...t.body.map((line) => fill(line, raw)),
    ...(t.button && url ? ['', `${t.button}: ${url}`] : []),
    ...(t.footer ? ['', t.footer] : []),
  ].join('\n');
  return {
    subject: fill(t.subject, raw),
    html: layoutEmail(
      fill(t.title, html),
      `${paragraphs}${cta}${footer}`,
      { platformName: brand?.platformName },
      lang === 'ar' ? 'rtl' : 'ltr',
    ),
    text,
  };
}
