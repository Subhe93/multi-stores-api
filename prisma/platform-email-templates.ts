/**
 * Platform default email templates (`NotificationTemplate`, one row per
 * event, per-locale JSON in subject / body_html / body_text): the single
 * source for `prisma/seed.ts` (fresh database) and
 * `prisma/scripts/platform-email-templates-sync.ts` (existing database).
 *
 * No Prisma import: pure data + string building, so it is unit-testable.
 *
 * Every event is defined in the six platform locales. The markup of an event
 * is built once and shared by all locales; only the human text differs.
 * Bodies use the {{var}} placeholders the MailService substitutes at send
 * time (allowed variables per event: NotificationTemplatesService
 * .EVENT_CATALOG).
 */
import {
  ONBOARDING_EVENTS,
  ONBOARDING_TEXT,
} from '../src/modules/mail/onboarding-templates';

export const PLATFORM_EMAIL_BRAND = 'ShopsDoor';

export const PLATFORM_EMAIL_LOCALES = [
  'en',
  'ar',
  'tr',
  'de',
  'fr',
  'sv',
] as const;
export type PlatformEmailLocale = (typeof PLATFORM_EMAIL_LOCALES)[number];

export interface TemplateText {
  subject: string;
  body_html: string;
  body_text: string;
}
/** event -> locale -> texts */
export type PlatformEmailTemplates = Record<
  string,
  Record<string, TemplateText>
>;

const BRAND = PLATFORM_EMAIL_BRAND;
const NL = '\n';
// Line break + indentation between the blocks of a body (kept byte-identical
// to the first seeded version so an untouched row compares equal).
const SEP = `${NL}           `;

/** Shared shell of the core events; the footer names the platform. */
export function platformEmailLayout(
  title: string,
  body: string,
  brand: string = BRAND,
): string {
  return [
    '<!doctype html>',
    '<html>',
    '  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">',
    '    <div style="max-width:480px;margin:0 auto;padding:24px;">',
    '      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">',
    `        <h1 style="font-size:18px;margin:0 0 16px;">${title}</h1>`,
    `        ${body}`,
    '      </div>',
    `      <p style="font-size:11px;color:#a1a1aa;text-align:center;margin-top:16px;">${brand}</p>`,
    '    </div>',
    '  </body>',
    '</html>',
  ].join(NL);
}

// ── Core events (orders / welcome / password_reset) ─────────────────────────

const P_INTRO = 'font-size:14px;line-height:1.6;color:#3f3f46;';
const P_VALUE = 'font-size:14px;color:#3f3f46;';
const P_NOTE = 'font-size:13px;color:#71717a;';
const P_SMALL = 'font-size:12px;color:#71717a;';
const BUTTON =
  'display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;';

/**
 * Human text of one core event in one locale. `label` is the caption of the
 * event's extra line ("Total:", "Tracking:", "Reason:", …) including its
 * colon, `button` the call-to-action text, `note` the small print.
 */
interface CorePhrases {
  subject: string;
  title: string;
  /** First paragraph (may contain <strong> and placeholders). */
  intro: string;
  label?: string;
  button?: string;
  note?: string;
  /** Complete plain-text body. */
  text: string;
}

type CoreEvent =
  | 'password_reset'
  | 'order_confirmation'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_fulfilled'
  | 'order_cancelled'
  | 'order_refunded'
  | 'new_order_owner'
  | 'welcome';

/** HTML body (inside the layout) of each core event; same for all locales. */
const CORE_MARKUP: Record<CoreEvent, (t: CorePhrases) => string> = {
  password_reset: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      `<p style="margin:20px 0;"><a href="{{reset_url}}" style="${BUTTON}">${t.button}</a></p>`,
      `<p style="${P_SMALL}">${t.note}</p>`,
    ].join(SEP),
  order_confirmation: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      '{{items_html}}',
      `<p style="${P_VALUE}">${t.label} <strong>{{total}}</strong></p>`,
      '{{order_button}}',
    ].join(SEP),
  order_shipped: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      '{{items_html}}',
      `<p style="${P_VALUE}">${t.label} <strong>{{tracking_number}}</strong></p>`,
      '{{order_button}}',
    ].join(SEP),
  order_delivered: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      '{{items_html}}',
      '{{order_button}}',
    ].join(SEP),
  // Fulfilment of an order that required no shipping: same markup as
  // order_delivered.
  order_fulfilled: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      '{{items_html}}',
      '{{order_button}}',
    ].join(SEP),
  order_cancelled: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      `<p style="${P_NOTE}">${t.label} {{reason}}</p>`,
      '{{items_html}}',
      '{{order_button}}',
    ].join(SEP),
  order_refunded: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      `<p style="${P_VALUE}">${t.label} <strong>{{refund_amount}}</strong></p>`,
      '{{items_html}}',
      '{{order_button}}',
    ].join(SEP),
  new_order_owner: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      `<p style="${P_NOTE}">${t.label} {{customer_name}}</p>`,
      '{{items_html}}',
      '{{order_button}}',
    ].join(SEP),
  welcome: (t) =>
    [
      `<p style="${P_INTRO}">${t.intro}</p>`,
      `<p style="margin:20px 0;"><a href="{{login_url}}" style="${BUTTON}">${t.button}</a></p>`,
    ].join(SEP),
};

const CORE_TEXT: Record<CoreEvent, Record<PlatformEmailLocale, CorePhrases>> = {
  password_reset: {
    en: {
      subject: `Reset your ${BRAND} password`,
      title: 'Reset your password',
      intro:
        'We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.',
      button: 'Reset password',
      note: "If you didn't request this, you can safely ignore this email.",
      text: `Reset your ${BRAND} password.\n\nOpen this link to choose a new password (expires in 1 hour):\n{{reset_url}}\n\nIf you didn't request this, ignore this email.`,
    },
    ar: {
      subject: `إعادة تعيين كلمة المرور — ${BRAND}`,
      title: 'إعادة تعيين كلمة المرور',
      intro:
        'تلقّينا طلباً لإعادة تعيين كلمة مرورك. اضغط الزر أدناه لاختيار كلمة جديدة. الرابط صالح لمدة ساعة.',
      button: 'إعادة التعيين',
      note: 'إن لم تكن أنت من طلب ذلك، يمكنك تجاهل هذه الرسالة.',
      text: `إعادة تعيين كلمة مرورك في ${BRAND}.\n\nافتح هذا الرابط لاختيار كلمة مرور جديدة (صالح ساعة واحدة):\n{{reset_url}}\n\nإن لم تكن أنت، تجاهل هذه الرسالة.`,
    },
    tr: {
      subject: `${BRAND} şifrenizi sıfırlayın`,
      title: 'Şifrenizi sıfırlayın',
      intro:
        'Şifrenizi sıfırlamak için bir talep aldık. Yeni bir şifre belirlemek için aşağıdaki butona tıklayın. Bu bağlantı 1 saat geçerlidir.',
      button: 'Şifreyi sıfırla',
      note: 'Bu talebi siz yapmadıysanız bu e-postayı dikkate almayabilirsiniz.',
      text: `${BRAND} şifrenizi sıfırlayın.\n\nYeni bir şifre belirlemek için bu bağlantıyı açın (1 saat geçerlidir):\n{{reset_url}}\n\nBu talebi siz yapmadıysanız bu e-postayı dikkate almayın.`,
    },
    de: {
      subject: `Setzen Sie Ihr ${BRAND}-Passwort zurück`,
      title: 'Passwort zurücksetzen',
      intro:
        'Wir haben eine Anfrage zum Zurücksetzen Ihres Passworts erhalten. Klicken Sie auf die Schaltfläche unten, um ein neues Passwort zu wählen. Dieser Link ist 1 Stunde gültig.',
      button: 'Passwort zurücksetzen',
      note: 'Wenn Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.',
      text: `Setzen Sie Ihr ${BRAND}-Passwort zurück.\n\nÖffnen Sie diesen Link, um ein neues Passwort zu wählen (1 Stunde gültig):\n{{reset_url}}\n\nWenn Sie dies nicht angefordert haben, ignorieren Sie diese E-Mail.`,
    },
    fr: {
      subject: `Réinitialisez votre mot de passe ${BRAND}`,
      title: 'Réinitialisez votre mot de passe',
      intro:
        'Nous avons reçu une demande de réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour en choisir un nouveau. Ce lien expire dans 1 heure.',
      button: 'Réinitialiser le mot de passe',
      note: 'Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.',
      text: `Réinitialisez votre mot de passe ${BRAND}.\n\nOuvrez ce lien pour choisir un nouveau mot de passe (il expire dans 1 heure) :\n{{reset_url}}\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.`,
    },
    sv: {
      subject: `Återställ ditt lösenord hos ${BRAND}`,
      title: 'Återställ ditt lösenord',
      intro:
        'Vi har fått en begäran om att återställa ditt lösenord. Klicka på knappen nedan för att välja ett nytt. Länken gäller i 1 timme.',
      button: 'Återställ lösenord',
      note: 'Om du inte har begärt detta kan du bortse från det här mejlet.',
      text: `Återställ ditt lösenord hos ${BRAND}.\n\nÖppna länken för att välja ett nytt lösenord (gäller i 1 timme):\n{{reset_url}}\n\nOm du inte har begärt detta kan du bortse från det här mejlet.`,
    },
  },
  order_confirmation: {
    en: {
      subject: `Order {{order_number}} confirmed`,
      title: 'Thanks for your order!',
      intro:
        'Your order <strong>{{order_number}}</strong> has been placed. {{payment_line}}',
      label: 'Total:',
      text: `Thanks for your order!\n\nOrder {{order_number}} has been placed. {{payment_line}}\n{{items_text}}\nTotal: {{total}}{{order_url_text}}`,
    },
    ar: {
      subject: `تمّ تأكيد الطلب {{order_number}}`,
      title: 'شكراً لطلبك!',
      intro:
        'تمّ استلام طلبك <strong>{{order_number}}</strong>. {{payment_line}}',
      label: 'الإجمالي:',
      text: `شكراً لطلبك!\n\nالطلب {{order_number}} تمّ استلامه. {{payment_line}}\n{{items_text}}\nالإجمالي: {{total}}{{order_url_text}}`,
    },
    tr: {
      subject: `{{order_number}} numaralı siparişiniz onaylandı`,
      title: 'Siparişiniz için teşekkürler!',
      intro:
        '<strong>{{order_number}}</strong> numaralı siparişiniz alındı. {{payment_line}}',
      label: 'Toplam:',
      text: `Siparişiniz için teşekkürler!\n\n{{order_number}} numaralı siparişiniz alındı. {{payment_line}}\n{{items_text}}\nToplam: {{total}}{{order_url_text}}`,
    },
    de: {
      subject: `Bestellung {{order_number}} bestätigt`,
      title: 'Vielen Dank für Ihre Bestellung!',
      intro:
        'Ihre Bestellung <strong>{{order_number}}</strong> ist bei uns eingegangen. {{payment_line}}',
      label: 'Gesamtbetrag:',
      text: `Vielen Dank für Ihre Bestellung!\n\nIhre Bestellung {{order_number}} ist bei uns eingegangen. {{payment_line}}\n{{items_text}}\nGesamtbetrag: {{total}}{{order_url_text}}`,
    },
    fr: {
      subject: `Commande {{order_number}} confirmée`,
      title: 'Merci pour votre commande !',
      intro:
        'Votre commande <strong>{{order_number}}</strong> a bien été enregistrée. {{payment_line}}',
      label: 'Total :',
      text: `Merci pour votre commande !\n\nVotre commande {{order_number}} a bien été enregistrée. {{payment_line}}\n{{items_text}}\nTotal : {{total}}{{order_url_text}}`,
    },
    sv: {
      subject: `Din beställning {{order_number}} är bekräftad`,
      title: 'Tack för din beställning!',
      intro:
        'Vi har tagit emot din beställning <strong>{{order_number}}</strong>. {{payment_line}}',
      label: 'Totalt:',
      text: `Tack för din beställning!\n\nVi har tagit emot din beställning {{order_number}}. {{payment_line}}\n{{items_text}}\nTotalt: {{total}}{{order_url_text}}`,
    },
  },
  order_shipped: {
    en: {
      subject: `Your order {{order_number}} is on the way`,
      title: 'Your order has shipped',
      intro:
        'Good news — your order <strong>{{order_number}}</strong> has been shipped.',
      label: 'Tracking:',
      text: `Your order {{order_number}} has shipped.\n{{items_text}}\nTracking: {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
    },
    ar: {
      subject: `طلبك {{order_number}} في طريقه إليك`,
      title: 'تمّ شحن طلبك',
      intro: 'خبر سار — تمّ شحن طلبك <strong>{{order_number}}</strong>.',
      label: 'رقم التتبّع:',
      text: `تمّ شحن طلبك {{order_number}}.\n{{items_text}}\nرقم التتبّع: {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
    },
    tr: {
      subject: `{{order_number}} numaralı siparişiniz yola çıktı`,
      title: 'Siparişiniz kargoya verildi',
      intro:
        'Güzel haber — <strong>{{order_number}}</strong> numaralı siparişiniz kargoya verildi.',
      label: 'Takip numarası:',
      text: `{{order_number}} numaralı siparişiniz kargoya verildi.\n{{items_text}}\nTakip numarası: {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
    },
    de: {
      subject: `Ihre Bestellung {{order_number}} ist unterwegs`,
      title: 'Ihre Bestellung wurde versandt',
      intro:
        'Gute Nachrichten – Ihre Bestellung <strong>{{order_number}}</strong> wurde versandt.',
      label: 'Sendungsnummer:',
      text: `Ihre Bestellung {{order_number}} wurde versandt.\n{{items_text}}\nSendungsnummer: {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
    },
    fr: {
      subject: `Votre commande {{order_number}} est en route`,
      title: 'Votre commande a été expédiée',
      intro:
        'Bonne nouvelle : votre commande <strong>{{order_number}}</strong> a été expédiée.',
      label: 'Numéro de suivi :',
      text: `Votre commande {{order_number}} a été expédiée.\n{{items_text}}\nNuméro de suivi : {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
    },
    sv: {
      subject: `Din beställning {{order_number}} är på väg`,
      title: 'Din beställning har skickats',
      intro:
        'Goda nyheter – din beställning <strong>{{order_number}}</strong> har skickats.',
      label: 'Spårningsnummer:',
      text: `Din beställning {{order_number}} har skickats.\n{{items_text}}\nSpårningsnummer: {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
    },
  },
  order_delivered: {
    en: {
      subject: `Your order {{order_number}} has been delivered`,
      title: 'Delivered!',
      intro:
        'Your order <strong>{{order_number}}</strong> has been marked as delivered. We hope you love it.',
      text: `Your order {{order_number}} has been delivered.\n{{items_text}}{{order_url_text}}`,
    },
    ar: {
      subject: `تمّ توصيل طلبك {{order_number}}`,
      title: 'تمّ التوصيل!',
      intro:
        'تمّ تسليم طلبك <strong>{{order_number}}</strong>. نأمل أن ينال إعجابك.',
      text: `تمّ توصيل طلبك {{order_number}}.\n{{items_text}}{{order_url_text}}`,
    },
    tr: {
      subject: `{{order_number}} numaralı siparişiniz teslim edildi`,
      title: 'Teslim edildi!',
      intro:
        '<strong>{{order_number}}</strong> numaralı siparişiniz teslim edildi olarak işaretlendi. Umarız beğenirsiniz.',
      text: `{{order_number}} numaralı siparişiniz teslim edildi.\n{{items_text}}{{order_url_text}}`,
    },
    de: {
      subject: `Ihre Bestellung {{order_number}} wurde zugestellt`,
      title: 'Zugestellt!',
      intro:
        'Ihre Bestellung <strong>{{order_number}}</strong> wurde als zugestellt markiert. Wir hoffen, sie gefällt Ihnen.',
      text: `Ihre Bestellung {{order_number}} wurde zugestellt.\n{{items_text}}{{order_url_text}}`,
    },
    fr: {
      subject: `Votre commande {{order_number}} a été livrée`,
      title: 'Livrée !',
      intro:
        'Votre commande <strong>{{order_number}}</strong> a été marquée comme livrée. Nous espérons qu’elle vous plaira.',
      text: `Votre commande {{order_number}} a été livrée.\n{{items_text}}{{order_url_text}}`,
    },
    sv: {
      subject: `Din beställning {{order_number}} har levererats`,
      title: 'Levererad!',
      intro:
        'Din beställning <strong>{{order_number}}</strong> har markerats som levererad. Vi hoppas att du blir nöjd med ditt köp.',
      text: `Din beställning {{order_number}} har levererats.\n{{items_text}}{{order_url_text}}`,
    },
  },
  order_fulfilled: {
    en: {
      subject: `Your order {{order_number}} is complete`,
      title: 'Your order is complete',
      intro:
        'Your order <strong>{{order_number}}</strong> has been completed. Thank you for your purchase.',
      text: `Your order {{order_number}} is complete.\n{{items_text}}{{order_url_text}}`,
    },
    ar: {
      subject: `اكتمل طلبك {{order_number}}`,
      title: 'اكتمل طلبك',
      intro:
        'تمّ إكمال طلبك <strong>{{order_number}}</strong>. شكرًا لشرائك.',
      text: `اكتمل طلبك {{order_number}}.\n{{items_text}}{{order_url_text}}`,
    },
    tr: {
      subject: `{{order_number}} numaralı siparişiniz tamamlandı`,
      title: 'Siparişiniz tamamlandı',
      intro:
        '<strong>{{order_number}}</strong> numaralı siparişiniz tamamlandı. Alışverişiniz için teşekkür ederiz.',
      text: `{{order_number}} numaralı siparişiniz tamamlandı.\n{{items_text}}{{order_url_text}}`,
    },
    de: {
      subject: `Ihre Bestellung {{order_number}} ist abgeschlossen`,
      title: 'Ihre Bestellung ist abgeschlossen',
      intro:
        'Ihre Bestellung <strong>{{order_number}}</strong> wurde abgeschlossen. Vielen Dank für Ihren Einkauf.',
      text: `Ihre Bestellung {{order_number}} ist abgeschlossen.\n{{items_text}}{{order_url_text}}`,
    },
    fr: {
      subject: `Votre commande {{order_number}} est terminée`,
      title: 'Votre commande est terminée',
      intro:
        'Votre commande <strong>{{order_number}}</strong> est terminée. Merci pour votre achat.',
      text: `Votre commande {{order_number}} est terminée.\n{{items_text}}{{order_url_text}}`,
    },
    sv: {
      subject: `Din beställning {{order_number}} är klar`,
      title: 'Din beställning är klar',
      intro:
        'Din beställning <strong>{{order_number}}</strong> är nu klar. Tack för ditt köp.',
      text: `Din beställning {{order_number}} är klar.\n{{items_text}}{{order_url_text}}`,
    },
  },
  order_cancelled: {
    en: {
      subject: `Order {{order_number}} cancelled`,
      title: 'Your order has been cancelled',
      intro:
        'Order <strong>{{order_number}}</strong> was cancelled. If you were charged, the refund is being processed.',
      label: 'Reason:',
      text: `Order {{order_number}} has been cancelled.\nReason: {{reason}}\n{{items_text}}{{order_url_text}}`,
    },
    ar: {
      subject: `تمّ إلغاء الطلب {{order_number}}`,
      title: 'تمّ إلغاء طلبك',
      intro:
        'تمّ إلغاء الطلب <strong>{{order_number}}</strong>. إن كنتَ قد دفعت، يجري الآن استرداد المبلغ.',
      label: 'السبب:',
      text: `تمّ إلغاء الطلب {{order_number}}.\nالسبب: {{reason}}\n{{items_text}}{{order_url_text}}`,
    },
    tr: {
      subject: `{{order_number}} numaralı sipariş iptal edildi`,
      title: 'Siparişiniz iptal edildi',
      intro:
        '<strong>{{order_number}}</strong> numaralı sipariş iptal edildi. Ödeme yaptıysanız iade işleminiz yapılıyor.',
      label: 'Neden:',
      text: `{{order_number}} numaralı sipariş iptal edildi.\nNeden: {{reason}}\n{{items_text}}{{order_url_text}}`,
    },
    de: {
      subject: `Bestellung {{order_number}} storniert`,
      title: 'Ihre Bestellung wurde storniert',
      intro:
        'Die Bestellung <strong>{{order_number}}</strong> wurde storniert. Falls Sie bereits bezahlt haben, wird die Rückerstattung bearbeitet.',
      label: 'Grund:',
      text: `Die Bestellung {{order_number}} wurde storniert.\nGrund: {{reason}}\n{{items_text}}{{order_url_text}}`,
    },
    fr: {
      subject: `Commande {{order_number}} annulée`,
      title: 'Votre commande a été annulée',
      intro:
        'La commande <strong>{{order_number}}</strong> a été annulée. Si vous avez été débité, le remboursement est en cours de traitement.',
      label: 'Motif :',
      text: `La commande {{order_number}} a été annulée.\nMotif : {{reason}}\n{{items_text}}{{order_url_text}}`,
    },
    sv: {
      subject: `Din beställning {{order_number}} har makulerats`,
      title: 'Din beställning har makulerats',
      intro:
        'Beställning <strong>{{order_number}}</strong> har makulerats. Om du redan har betalat återförs beloppet.',
      label: 'Anledning:',
      text: `Din beställning {{order_number}} har makulerats.\nAnledning: {{reason}}\n{{items_text}}{{order_url_text}}`,
    },
  },
  order_refunded: {
    en: {
      subject: `Refund processed for order {{order_number}}`,
      title: 'Refund processed',
      intro:
        'A refund has been processed for order <strong>{{order_number}}</strong>. It may take a few business days to appear on your statement.',
      label: 'Refunded amount:',
      text: `Refund processed for order {{order_number}}.\nAmount: {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
    },
    ar: {
      subject: `تمّ استرداد المبلغ للطلب {{order_number}}`,
      title: 'تمّ الاسترداد',
      intro:
        'تمّ استرداد مبلغ الطلب <strong>{{order_number}}</strong>. قد يستغرق ظهوره في كشف حسابك بضعة أيام عمل.',
      label: 'المبلغ المُعاد:',
      text: `تمّ استرداد مبلغ الطلب {{order_number}}.\nالمبلغ: {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
    },
    tr: {
      subject: `{{order_number}} numaralı sipariş için iade yapıldı`,
      title: 'İade yapıldı',
      intro:
        '<strong>{{order_number}}</strong> numaralı sipariş için iade işlemi yapıldı. Tutarın hesap ekstrenizde görünmesi birkaç iş günü sürebilir.',
      label: 'İade edilen tutar:',
      text: `{{order_number}} numaralı sipariş için iade yapıldı.\nTutar: {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
    },
    de: {
      subject: `Rückerstattung für Bestellung {{order_number}}`,
      title: 'Rückerstattung veranlasst',
      intro:
        'Für die Bestellung <strong>{{order_number}}</strong> wurde eine Rückerstattung veranlasst. Es kann einige Werktage dauern, bis der Betrag auf Ihrem Konto erscheint.',
      label: 'Erstatteter Betrag:',
      text: `Rückerstattung für Bestellung {{order_number}} veranlasst.\nBetrag: {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
    },
    fr: {
      subject: `Remboursement effectué pour la commande {{order_number}}`,
      title: 'Remboursement effectué',
      intro:
        'Un remboursement a été effectué pour la commande <strong>{{order_number}}</strong>. Il peut falloir quelques jours ouvrés avant qu’il n’apparaisse sur votre relevé.',
      label: 'Montant remboursé :',
      text: `Remboursement effectué pour la commande {{order_number}}.\nMontant : {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
    },
    sv: {
      subject: `Återbetalning för order {{order_number}}`,
      title: 'Återbetalning genomförd',
      intro:
        'En återbetalning har gjorts för beställning <strong>{{order_number}}</strong>. Det kan ta några bankdagar innan beloppet syns på ditt konto.',
      label: 'Återbetalat belopp:',
      text: `Återbetalning genomförd för order {{order_number}}.\nBelopp: {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
    },
  },
  new_order_owner: {
    en: {
      subject: `New order {{order_number}} — {{store_name}}`,
      title: 'New order received',
      intro:
        'You have a new order <strong>{{order_number}}</strong> totalling <strong>{{total}}</strong>.',
      label: 'Customer:',
      text: `New order {{order_number}} for {{store_name}}. Total: {{total}}.\nCustomer: {{customer_name}}\n{{items_text}}{{order_url_text}}`,
    },
    ar: {
      subject: `طلب جديد {{order_number}} — {{store_name}}`,
      title: 'تمّ استلام طلب جديد',
      intro:
        'لديك طلب جديد <strong>{{order_number}}</strong> بإجمالي <strong>{{total}}</strong>.',
      label: 'العميل:',
      text: `طلب جديد {{order_number}} لمتجر {{store_name}}. الإجمالي: {{total}}.\nالعميل: {{customer_name}}\n{{items_text}}{{order_url_text}}`,
    },
    tr: {
      subject: `Yeni sipariş {{order_number}} — {{store_name}}`,
      title: 'Yeni sipariş alındı',
      intro:
        'Toplam <strong>{{total}}</strong> tutarında yeni bir siparişiniz var: <strong>{{order_number}}</strong>.',
      label: 'Müşteri:',
      text: `{{store_name}} için yeni sipariş {{order_number}}. Toplam: {{total}}.\nMüşteri: {{customer_name}}\n{{items_text}}{{order_url_text}}`,
    },
    de: {
      subject: `Neue Bestellung {{order_number}} – {{store_name}}`,
      title: 'Neue Bestellung eingegangen',
      intro:
        'Sie haben eine neue Bestellung <strong>{{order_number}}</strong> über insgesamt <strong>{{total}}</strong>.',
      label: 'Kunde:',
      text: `Neue Bestellung {{order_number}} für {{store_name}}. Gesamtbetrag: {{total}}.\nKunde: {{customer_name}}\n{{items_text}}{{order_url_text}}`,
    },
    fr: {
      subject: `Nouvelle commande {{order_number}} — {{store_name}}`,
      title: 'Nouvelle commande reçue',
      intro:
        'Vous avez une nouvelle commande <strong>{{order_number}}</strong> d’un montant total de <strong>{{total}}</strong>.',
      label: 'Client :',
      text: `Nouvelle commande {{order_number}} pour {{store_name}}. Total : {{total}}.\nClient : {{customer_name}}\n{{items_text}}{{order_url_text}}`,
    },
    sv: {
      subject: `Ny beställning {{order_number}} – {{store_name}}`,
      title: 'Ny beställning mottagen',
      intro:
        'Du har fått en ny beställning <strong>{{order_number}}</strong> på totalt <strong>{{total}}</strong>.',
      label: 'Kund:',
      text: `Ny beställning {{order_number}} i {{store_name}}. Totalt: {{total}}.\nKund: {{customer_name}}\n{{items_text}}{{order_url_text}}`,
    },
  },
  welcome: {
    en: {
      subject: `Welcome to ${BRAND}`,
      title: `Welcome to ${BRAND}`,
      intro:
        "Hi {{name}}, we're glad you're here. Your account is ready — start exploring stores and products built by independent creators.",
      button: 'Sign in',
      text: `Welcome to ${BRAND}!\n\nHi {{name}}, your account is ready.\n\nSign in: {{login_url}}`,
    },
    ar: {
      subject: `أهلاً بك في ${BRAND}`,
      title: `أهلاً بك في ${BRAND}`,
      intro:
        'مرحباً {{name}}، يسعدنا انضمامك. حسابك جاهز — استكشف المتاجر والمنتجات التي يصنعها مبدعون مستقلون.',
      button: 'تسجيل الدخول',
      text: `أهلاً بك في ${BRAND}!\n\nمرحباً {{name}}، حسابك جاهز.\n\nسجّل الدخول: {{login_url}}`,
    },
    tr: {
      subject: `${BRAND}'a hoş geldiniz`,
      title: `${BRAND}'a hoş geldiniz`,
      intro:
        'Merhaba {{name}}, aramıza katıldığınız için çok mutluyuz. Hesabınız hazır — bağımsız üreticilerin oluşturduğu mağazaları ve ürünleri keşfetmeye başlayın.',
      button: 'Giriş yap',
      text: `${BRAND}'a hoş geldiniz!\n\nMerhaba {{name}}, hesabınız hazır.\n\nGiriş yapın: {{login_url}}`,
    },
    de: {
      subject: `Willkommen bei ${BRAND}`,
      title: `Willkommen bei ${BRAND}`,
      intro:
        'Hallo {{name}}, schön, dass Sie da sind. Ihr Konto ist bereit – entdecken Sie Shops und Produkte unabhängiger Kreativer.',
      button: 'Anmelden',
      text: `Willkommen bei ${BRAND}!\n\nHallo {{name}}, Ihr Konto ist bereit.\n\nAnmelden: {{login_url}}`,
    },
    fr: {
      subject: `Bienvenue sur ${BRAND}`,
      title: `Bienvenue sur ${BRAND}`,
      intro:
        'Bonjour {{name}}, nous sommes ravis de vous accueillir. Votre compte est prêt : découvrez des boutiques et des produits conçus par des créateurs indépendants.',
      button: 'Se connecter',
      text: `Bienvenue sur ${BRAND} !\n\nBonjour {{name}}, votre compte est prêt.\n\nSe connecter : {{login_url}}`,
    },
    sv: {
      subject: `Välkommen till ${BRAND}`,
      title: `Välkommen till ${BRAND}`,
      intro:
        'Hej {{name}}, vad roligt att du är här. Ditt konto är klart – börja utforska butiker och produkter från fristående kreatörer.',
      button: 'Logga in',
      text: `Välkommen till ${BRAND}!\n\nHej {{name}}, ditt konto är klart.\n\nLogga in: {{login_url}}`,
    },
  },
};

function buildCoreTemplates(): PlatformEmailTemplates {
  const out: PlatformEmailTemplates = {};
  for (const event of Object.keys(CORE_TEXT) as CoreEvent[]) {
    out[event] = {};
    for (const loc of PLATFORM_EMAIL_LOCALES) {
      const t = CORE_TEXT[event][loc];
      out[event][loc] = {
        subject: t.subject,
        body_html: platformEmailLayout(t.title, CORE_MARKUP[event](t)),
        body_text: t.text,
      };
    }
  }
  return out;
}

// ── account_created ─────────────────────────────────────────────────────────

// Same wording as the bundled builder (src/modules/mail/templates.ts →
// ACCOUNT_CREATED_TEXT), in all six locales so no language silently falls
// back to English. Tokens: {store}, {name}, {hours}.
const ACCOUNT_CREATED: Record<PlatformEmailLocale, Record<string, string>> = {
  en: {
    subject: 'Your account at {store}',
    title: 'Your account is ready',
    greeting: 'Hi {name},',
    greetingNoName: 'Hi there,',
    intro:
      'An account has been created for you at {store}. Here are your login details:',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    button: 'Log in with one click',
    validity: 'This button is valid for {hours} hours and can be used once.',
    loginLead: 'Or log in with your email and password:',
    loginLink: 'Log in',
    changePassword:
      'We recommend changing your password after you log in (Account → Change password).',
    ignore: 'If you did not place an order, you can ignore this email.',
  },
  ar: {
    subject: 'حسابك في {store}',
    title: 'حسابك جاهز',
    greeting: 'مرحباً {name}،',
    greetingNoName: 'مرحباً،',
    intro: 'تم إنشاء حساب لك في {store}. هذه بيانات الدخول الخاصة بك:',
    emailLabel: 'البريد الإلكتروني',
    passwordLabel: 'كلمة المرور',
    button: 'تسجيل الدخول بنقرة واحدة',
    validity: 'هذا الزر صالح لمدة {hours} ساعة ويمكن استخدامه مرة واحدة فقط.',
    loginLead: 'أو سجّل الدخول ببريدك الإلكتروني وكلمة المرور:',
    loginLink: 'تسجيل الدخول',
    changePassword:
      'ننصحك بتغيير كلمة المرور بعد تسجيل الدخول (الحساب ← تغيير كلمة المرور).',
    ignore: 'إذا لم تقم بأي طلب، يمكنك تجاهل هذه الرسالة.',
  },
  tr: {
    subject: '{store} hesabınız',
    title: 'Hesabınız hazır',
    greeting: 'Merhaba {name},',
    greetingNoName: 'Merhaba,',
    intro:
      '{store} üzerinde sizin için bir hesap oluşturuldu. Giriş bilgileriniz:',
    emailLabel: 'E-posta',
    passwordLabel: 'Şifre',
    button: 'Tek tıkla giriş yap',
    validity:
      'Bu buton {hours} saat geçerlidir ve yalnızca bir kez kullanılabilir.',
    loginLead: 'Ya da e-posta adresiniz ve şifrenizle giriş yapın:',
    loginLink: 'Giriş yap',
    changePassword:
      'Giriş yaptıktan sonra şifrenizi değiştirmenizi öneririz (Hesap → Şifreyi değiştir).',
    ignore: 'Bir sipariş vermediyseniz bu e-postayı dikkate almayabilirsiniz.',
  },
  de: {
    subject: 'Ihr Konto bei {store}',
    title: 'Ihr Konto ist bereit',
    greeting: 'Hallo {name},',
    greetingNoName: 'Hallo,',
    intro:
      'Für Sie wurde ein Konto bei {store} erstellt. Hier sind Ihre Zugangsdaten:',
    emailLabel: 'E-Mail',
    passwordLabel: 'Passwort',
    button: 'Mit einem Klick anmelden',
    validity:
      'Dieser Button ist {hours} Stunden gültig und kann einmal verwendet werden.',
    loginLead: 'Oder melden Sie sich mit E-Mail und Passwort an:',
    loginLink: 'Anmelden',
    changePassword:
      'Wir empfehlen, das Passwort nach der Anmeldung zu ändern (Konto → Passwort ändern).',
    ignore:
      'Wenn Sie keine Bestellung aufgegeben haben, können Sie diese E-Mail ignorieren.',
  },
  fr: {
    subject: 'Votre compte sur {store}',
    title: 'Votre compte est prêt',
    greeting: 'Bonjour {name},',
    greetingNoName: 'Bonjour,',
    intro:
      'Un compte a été créé pour vous sur {store}. Voici vos identifiants :',
    emailLabel: 'E-mail',
    passwordLabel: 'Mot de passe',
    button: 'Se connecter en un clic',
    validity:
      'Ce bouton est valable {hours} heures et ne peut être utilisé qu’une seule fois.',
    loginLead: 'Ou connectez-vous avec votre e-mail et votre mot de passe :',
    loginLink: 'Se connecter',
    changePassword:
      'Nous vous recommandons de changer votre mot de passe après connexion (Compte → Changer le mot de passe).',
    ignore:
      'Si vous n’avez passé aucune commande, vous pouvez ignorer cet e-mail.',
  },
  sv: {
    subject: 'Ditt konto hos {store}',
    title: 'Ditt konto är klart',
    greeting: 'Hej {name},',
    greetingNoName: 'Hej,',
    intro:
      'Ett konto har skapats åt dig hos {store}. Här är dina inloggningsuppgifter:',
    emailLabel: 'E-post',
    passwordLabel: 'Lösenord',
    button: 'Logga in med ett klick',
    validity: 'Knappen gäller i {hours} timmar och kan användas en gång.',
    loginLead: 'Eller logga in med din e-post och ditt lösenord:',
    loginLink: 'Logga in',
    changePassword:
      'Vi rekommenderar att du byter lösenord när du har loggat in (Konto → Byt lösenord).',
    ignore:
      'Om du inte har lagt någon beställning kan du bortse från det här mejlet.',
  },
};

const accountPlaceholders = (phrase: string) =>
  phrase
    .split('{store}')
    .join('{{store_name}}')
    .split('{name}')
    .join('{{name}}')
    .split('{hours}')
    .join('{{expires_hours}}');

/** RTL-aware layout; the footer names the store (or the platform). */
function accountLayout(title: string, body: string, rtl: boolean): string {
  const dir = rtl ? ' dir="rtl"' : '';
  return [
    '<!doctype html>',
    `<html${dir}>`,
    `  <body${dir} style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">`,
    '    <div style="max-width:520px;margin:0 auto;padding:24px;">',
    '      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">',
    `        <h1 style="font-size:18px;margin:0 0 16px;">${title}</h1>`,
    `        ${body}`,
    '      </div>',
    '      <p style="font-size:11px;color:#a1a1aa;text-align:center;margin-top:16px;">{{store_name}}</p>',
    '    </div>',
    '  </body>',
    '</html>',
  ].join(NL);
}

function buildAccountCreated(): Record<string, TemplateText> {
  const out: Record<string, TemplateText> = {};
  const p = 'font-size:14px;line-height:1.6;color:#3f3f46;';
  const small = 'font-size:12px;line-height:1.6;color:#71717a;';
  const label = 'font-size:12px;color:#71717a;';
  const value =
    "font-family:'Courier New',Courier,monospace;font-size:15px;color:#18181b;";
  for (const loc of PLATFORM_EMAIL_LOCALES) {
    const t = ACCOUNT_CREATED[loc];
    const greeting = `{{#if name}}${accountPlaceholders(t.greeting)}{{/if}}{{#unless name}}${t.greetingNoName}{{/unless}}`;
    out[loc] = {
      subject: accountPlaceholders(t.subject),
      body_html: accountLayout(
        t.title,
        [
          `<p style="${p}margin:0 0 8px;">${greeting}</p>`,
          `<p style="${p}margin:0 0 16px;">${accountPlaceholders(t.intro)}</p>`,
          '<div style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:14px 16px;margin:0 0 20px;">',
          `  <p style="${label}margin:0 0 2px;">${t.emailLabel}</p>`,
          `  <p style="margin:0 0 12px;"><span dir="ltr" style="${value}">{{email}}</span></p>`,
          `  <p style="${label}margin:0 0 2px;">${t.passwordLabel}</p>`,
          `  <p style="margin:0;"><span dir="ltr" style="${value}font-weight:600;letter-spacing:1px;user-select:all;-webkit-user-select:all;">{{password}}</span></p>`,
          '</div>',
          `<p style="margin:0 0 8px;"><a href="{{magic_url}}" style="${BUTTON}">${t.button}</a></p>`,
          `<p style="${small}margin:0 0 20px;">${accountPlaceholders(t.validity)}</p>`,
          `<p style="${p}margin:0 0 16px;">${t.loginLead} <a href="{{login_url}}" style="color:#18181b;font-weight:600;">${t.loginLink}</a></p>`,
          `<p style="${small}margin:0 0 8px;">${t.changePassword}</p>`,
          `<p style="${small}margin:0;">${t.ignore}</p>`,
        ].join(SEP),
        loc === 'ar',
      ),
      body_text: [
        greeting,
        '',
        accountPlaceholders(t.intro),
        `${t.emailLabel}: {{email}}`,
        `${t.passwordLabel}: {{password}}`,
        '',
        `${t.button}: {{magic_url}}`,
        accountPlaceholders(t.validity),
        '',
        `${t.loginLead} {{login_url}}`,
        '',
        t.changePassword,
        t.ignore,
      ].join(NL),
    };
  }
  return out;
}

// ── Platform onboarding events ──────────────────────────────────────────────

/**
 * Phrase token -> {{var}} placeholder of the onboarding wording
 * (src/modules/mail/onboarding-templates.ts, plans/platform-onboarding SPEC §5).
 */
export const ONBOARDING_TOKEN_VARS: Record<string, string> = {
  platform: 'platform_name',
  name: 'name',
  store: 'store_name',
  store_slug: 'store_slug',
  store_url: 'store_url',
  dashboard_url: 'dashboard_url',
  support_email: 'support_email',
  reason: 'reason',
  company: 'company_name',
  hours: 'expires_hours',
  days_left: 'days_left',
  email: 'email',
  owner_email: 'owner_email',
  account_kind: 'account_kind',
  country: 'country',
  disposable: 'disposable',
  checklist: 'checklist',
  verify_url: 'verify_url',
  admin_url: 'admin_url',
  review_url: 'review_url',
  // backup_offsite_missing
  bucket: 'bucket',
  last_success: 'last_success',
  hours_since: 'hours_since',
  checked_at: 'checked_at',
};

/** Which variable the call-to-action button links to, per event. */
export const ONBOARDING_BUTTON_VAR: Record<string, string> = {
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
  backup_offsite_missing: 'admin_url',
};

/**
 * Onboarding templates from the bundled wording. The maps are parameters so
 * the sync script can rebuild what an earlier seed wrote (see
 * platform-email-templates-sync.legacy.ts).
 */
export function buildOnboardingTemplates(
  locales: readonly string[] = PLATFORM_EMAIL_LOCALES,
  tokenVars: Record<string, string> = ONBOARDING_TOKEN_VARS,
  buttonVars: Record<string, string> = ONBOARDING_BUTTON_VAR,
): PlatformEmailTemplates {
  const fill = (phrase: string) =>
    Object.entries(tokenVars).reduce(
      (out, [token, v]) => out.split(`{${token}}`).join(`{{${v}}}`),
      phrase,
    );
  const p = 'font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 12px;';
  const small = 'font-size:12px;line-height:1.6;color:#71717a;margin:12px 0 0;';
  const out: PlatformEmailTemplates = {};
  for (const event of ONBOARDING_EVENTS) {
    const perLocale: Record<string, TemplateText> = {};
    for (const loc of locales) {
      const t = ONBOARDING_TEXT[event][loc];
      if (!t) continue;
      const urlVar = buttonVars[event];
      const cta =
        t.button && urlVar
          ? `<p style="margin:20px 0 0;"><a href="{{${urlVar}}}" style="${BUTTON}">${t.button}</a></p>`
          : '';
      perLocale[loc] = {
        subject: fill(t.subject),
        body_html: accountLayout(
          fill(t.title),
          t.body.map((line) => `<p style="${p}">${fill(line)}</p>`).join(NL) +
            cta +
            (t.footer ? `<p style="${small}">${t.footer}</p>` : ''),
          loc === 'ar',
        ),
        body_text: [
          ...t.body.map((line) => fill(line)),
          ...(t.button && urlVar ? ['', `${t.button}: {{${urlVar}}}`] : []),
          ...(t.footer ? ['', t.footer] : []),
        ].join(NL),
      };
    }
    out[event] = perLocale;
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Every platform default template: event -> locale -> texts. */
export function buildPlatformEmailTemplates(): PlatformEmailTemplates {
  return {
    ...buildCoreTemplates(),
    account_created: buildAccountCreated(),
    ...buildOnboardingTemplates(),
  };
}

/** The three per-locale JSON columns of one event's row. */
export function toTemplateColumns(perLocale: Record<string, TemplateText>): {
  subject: Record<string, string>;
  body_html: Record<string, string>;
  body_text: Record<string, string>;
} {
  const subject: Record<string, string> = {};
  const body_html: Record<string, string> = {};
  const body_text: Record<string, string> = {};
  for (const [loc, t] of Object.entries(perLocale)) {
    subject[loc] = t.subject;
    body_html[loc] = t.body_html;
    body_text[loc] = t.body_text;
  }
  return { subject, body_html, body_text };
}
