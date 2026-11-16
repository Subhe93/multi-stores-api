/**
 * Known OLD platform default email texts, for
 * `platform-email-templates-sync.ts`: a stored text that equals one of these
 * was written by an earlier seed and never edited by an admin, so the sync
 * may replace it with the current default. Anything else is treated as
 * admin-edited and kept.
 *
 * Frozen copies of what `prisma/seed.ts` wrote in its earlier versions
 * (git history of prisma/seed.ts); do NOT "fix" or reformat the texts in
 * here, they must stay byte-identical to what is stored in old databases.
 *
 *   generation 1 (seed of 2026-05-23): password_reset and order_confirmation
 *     only, en + ar, brand "Multi Stores", order_confirmation WITHOUT
 *     {{items_html}} / {{items_text}};
 *   generation 2 (seed of 2026-06-03 .. 2026-11-01): the eight core events,
 *     en + ar, brand "Multi Stores", with the items placeholders;
 *   backup_offsite_missing as seeded before the shared module: the
 *     {bucket} / {last_success} / {hours_since} / {checked_at} tokens were
 *     left as single-brace text and the button was missing (en + ar).
 *
 * Generation 3 (brand "ShopsDoor", en + ar) is byte-identical to the en / ar
 * texts of the current defaults, so it needs no entry here.
 */
import {
  ONBOARDING_BUTTON_VAR,
  ONBOARDING_TOKEN_VARS,
  buildOnboardingTemplates,
  type TemplateText,
} from '../platform-email-templates';

type Texts = Record<string, Record<string, TemplateText>>;

function legacyCoreTemplates(): { gen1: Texts; gen2: Texts } {
  const BRAND = 'Multi Stores';
  const layout = (title: string, body: string) => `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
    <div style="max-width:480px;margin:0 auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">
        <h1 style="font-size:18px;margin:0 0 16px;">${title}</h1>
        ${body}
      </div>
      <p style="font-size:11px;color:#a1a1aa;text-align:center;margin-top:16px;">${BRAND}</p>
    </div>
  </body>
</html>`;

  const gen2: Texts = {
    password_reset: {
      en: {
        subject: `Reset your ${BRAND} password`,
        body_html: layout(
          'Reset your password',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.</p>
           <p style="margin:20px 0;"><a href="{{reset_url}}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">Reset password</a></p>
           <p style="font-size:12px;color:#71717a;">If you didn't request this, you can safely ignore this email.</p>`,
        ),
        body_text: `Reset your ${BRAND} password.\n\nOpen this link to choose a new password (expires in 1 hour):\n{{reset_url}}\n\nIf you didn't request this, ignore this email.`,
      },
      ar: {
        subject: `إعادة تعيين كلمة المرور — ${BRAND}`,
        body_html: layout(
          'إعادة تعيين كلمة المرور',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">تلقّينا طلباً لإعادة تعيين كلمة مرورك. اضغط الزر أدناه لاختيار كلمة جديدة. الرابط صالح لمدة ساعة.</p>
           <p style="margin:20px 0;"><a href="{{reset_url}}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">إعادة التعيين</a></p>
           <p style="font-size:12px;color:#71717a;">إن لم تكن أنت من طلب ذلك، يمكنك تجاهل هذه الرسالة.</p>`,
        ),
        body_text: `إعادة تعيين كلمة مرورك في ${BRAND}.\n\nافتح هذا الرابط لاختيار كلمة مرور جديدة (صالح ساعة واحدة):\n{{reset_url}}\n\nإن لم تكن أنت، تجاهل هذه الرسالة.`,
      },
    },
    order_confirmation: {
      en: {
        subject: `Order {{order_number}} confirmed`,
        body_html: layout(
          'Thanks for your order!',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">Your order <strong>{{order_number}}</strong> has been placed. {{payment_line}}</p>
           {{items_html}}
           <p style="font-size:14px;color:#3f3f46;">Total: <strong>{{total}}</strong></p>
           {{order_button}}`,
        ),
        body_text: `Thanks for your order!\n\nOrder {{order_number}} has been placed. {{payment_line}}\n{{items_text}}\nTotal: {{total}}{{order_url_text}}`,
      },
      ar: {
        subject: `تمّ تأكيد الطلب {{order_number}}`,
        body_html: layout(
          'شكراً لطلبك!',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">تمّ استلام طلبك <strong>{{order_number}}</strong>. {{payment_line}}</p>
           {{items_html}}
           <p style="font-size:14px;color:#3f3f46;">الإجمالي: <strong>{{total}}</strong></p>
           {{order_button}}`,
        ),
        body_text: `شكراً لطلبك!\n\nالطلب {{order_number}} تمّ استلامه. {{payment_line}}\n{{items_text}}\nالإجمالي: {{total}}{{order_url_text}}`,
      },
    },
    order_shipped: {
      en: {
        subject: `Your order {{order_number}} is on the way`,
        body_html: layout(
          'Your order has shipped',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">Good news — your order <strong>{{order_number}}</strong> has been shipped.</p>
           {{items_html}}
           <p style="font-size:14px;color:#3f3f46;">Tracking: <strong>{{tracking_number}}</strong></p>
           {{order_button}}`,
        ),
        body_text: `Your order {{order_number}} has shipped.\n{{items_text}}\nTracking: {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
      },
      ar: {
        subject: `طلبك {{order_number}} في طريقه إليك`,
        body_html: layout(
          'تمّ شحن طلبك',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">خبر سار — تمّ شحن طلبك <strong>{{order_number}}</strong>.</p>
           {{items_html}}
           <p style="font-size:14px;color:#3f3f46;">رقم التتبّع: <strong>{{tracking_number}}</strong></p>
           {{order_button}}`,
        ),
        body_text: `تمّ شحن طلبك {{order_number}}.\n{{items_text}}\nرقم التتبّع: {{tracking_number}}\n{{tracking_url}}{{order_url_text}}`,
      },
    },
    order_delivered: {
      en: {
        subject: `Your order {{order_number}} has been delivered`,
        body_html: layout(
          'Delivered!',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">Your order <strong>{{order_number}}</strong> has been marked as delivered. We hope you love it.</p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `Your order {{order_number}} has been delivered.\n{{items_text}}{{order_url_text}}`,
      },
      ar: {
        subject: `تمّ توصيل طلبك {{order_number}}`,
        body_html: layout(
          'تمّ التوصيل!',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">تمّ تسليم طلبك <strong>{{order_number}}</strong>. نأمل أن ينال إعجابك.</p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `تمّ توصيل طلبك {{order_number}}.\n{{items_text}}{{order_url_text}}`,
      },
    },
    order_cancelled: {
      en: {
        subject: `Order {{order_number}} cancelled`,
        body_html: layout(
          'Your order has been cancelled',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">Order <strong>{{order_number}}</strong> was cancelled. If you were charged, the refund is being processed.</p>
           <p style="font-size:13px;color:#71717a;">Reason: {{reason}}</p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `Order {{order_number}} has been cancelled.\nReason: {{reason}}\n{{items_text}}{{order_url_text}}`,
      },
      ar: {
        subject: `تمّ إلغاء الطلب {{order_number}}`,
        body_html: layout(
          'تمّ إلغاء طلبك',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">تمّ إلغاء الطلب <strong>{{order_number}}</strong>. إن كنتَ قد دفعت، يجري الآن استرداد المبلغ.</p>
           <p style="font-size:13px;color:#71717a;">السبب: {{reason}}</p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `تمّ إلغاء الطلب {{order_number}}.\nالسبب: {{reason}}\n{{items_text}}{{order_url_text}}`,
      },
    },
    order_refunded: {
      en: {
        subject: `Refund processed for order {{order_number}}`,
        body_html: layout(
          'Refund processed',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">A refund has been processed for order <strong>{{order_number}}</strong>. It may take a few business days to appear on your statement.</p>
           <p style="font-size:14px;color:#3f3f46;">Refunded amount: <strong>{{refund_amount}}</strong></p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `Refund processed for order {{order_number}}.\nAmount: {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
      },
      ar: {
        subject: `تمّ استرداد المبلغ للطلب {{order_number}}`,
        body_html: layout(
          'تمّ الاسترداد',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">تمّ استرداد مبلغ الطلب <strong>{{order_number}}</strong>. قد يستغرق ظهوره في كشف حسابك بضعة أيام عمل.</p>
           <p style="font-size:14px;color:#3f3f46;">المبلغ المُعاد: <strong>{{refund_amount}}</strong></p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `تمّ استرداد مبلغ الطلب {{order_number}}.\nالمبلغ: {{refund_amount}}\n{{items_text}}{{order_url_text}}`,
      },
    },
    new_order_owner: {
      en: {
        subject: `New order {{order_number}} — {{store_name}}`,
        body_html: layout(
          'New order received',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">You have a new order <strong>{{order_number}}</strong> totalling <strong>{{total}}</strong>.</p>
           <p style="font-size:13px;color:#71717a;">Customer: {{customer_name}}</p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `New order {{order_number}} for {{store_name}}. Total: {{total}}.\nCustomer: {{customer_name}}\n{{items_text}}{{order_url_text}}`,
      },
      ar: {
        subject: `طلب جديد {{order_number}} — {{store_name}}`,
        body_html: layout(
          'تمّ استلام طلب جديد',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">لديك طلب جديد <strong>{{order_number}}</strong> بإجمالي <strong>{{total}}</strong>.</p>
           <p style="font-size:13px;color:#71717a;">العميل: {{customer_name}}</p>
           {{items_html}}
           {{order_button}}`,
        ),
        body_text: `طلب جديد {{order_number}} لمتجر {{store_name}}. الإجمالي: {{total}}.\nالعميل: {{customer_name}}\n{{items_text}}{{order_url_text}}`,
      },
    },
    welcome: {
      en: {
        subject: `Welcome to ${BRAND}`,
        body_html: layout(
          `Welcome to ${BRAND}`,
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{name}}, we're glad you're here. Your account is ready — start exploring stores and products built by independent creators.</p>
           <p style="margin:20px 0;"><a href="{{login_url}}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">Sign in</a></p>`,
        ),
        body_text: `Welcome to ${BRAND}!\n\nHi {{name}}, your account is ready.\n\nSign in: {{login_url}}`,
      },
      ar: {
        subject: `أهلاً بك في ${BRAND}`,
        body_html: layout(
          `أهلاً بك في ${BRAND}`,
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">مرحباً {{name}}، يسعدنا انضمامك. حسابك جاهز — استكشف المتاجر والمنتجات التي يصنعها مبدعون مستقلون.</p>
           <p style="margin:20px 0;"><a href="{{login_url}}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">تسجيل الدخول</a></p>`,
        ),
        body_text: `أهلاً بك في ${BRAND}!\n\nمرحباً {{name}}، حسابك جاهز.\n\nسجّل الدخول: {{login_url}}`,
      },
    },
  };

  // Generation 1: order_confirmation before the items placeholders.
  const gen1: Texts = {
    password_reset: gen2.password_reset,
    order_confirmation: {
      en: {
        subject: `Order {{order_number}} confirmed`,
        body_html: layout(
          'Thanks for your order!',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">Your order <strong>{{order_number}}</strong> has been placed. {{payment_line}}</p>
           <p style="font-size:14px;color:#3f3f46;">Total: <strong>{{total}}</strong></p>
           {{order_button}}`,
        ),
        body_text: `Thanks for your order!\n\nOrder {{order_number}} has been placed. {{payment_line}}\nTotal: {{total}}{{order_url_text}}`,
      },
      ar: {
        subject: `تمّ تأكيد الطلب {{order_number}}`,
        body_html: layout(
          'شكراً لطلبك!',
          `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">تمّ استلام طلبك <strong>{{order_number}}</strong>. {{payment_line}}</p>
           <p style="font-size:14px;color:#3f3f46;">الإجمالي: <strong>{{total}}</strong></p>
           {{order_button}}`,
        ),
        body_text: `شكراً لطلبك!\n\nالطلب {{order_number}} تمّ استلامه. {{payment_line}}\nالإجمالي: {{total}}{{order_url_text}}`,
      },
    },
  };

  return { gen1, gen2 };
}

/** backup_offsite_missing as the seed built it before the token/button fix. */
function legacyBackupOffsiteMissing(): Texts {
  const tokenVars = { ...ONBOARDING_TOKEN_VARS };
  for (const token of ['bucket', 'last_success', 'hours_since', 'checked_at'])
    delete tokenVars[token];
  const buttonVars = { ...ONBOARDING_BUTTON_VAR };
  delete buttonVars.backup_offsite_missing;
  const all = buildOnboardingTemplates(['en', 'ar'], tokenVars, buttonVars);
  return { backup_offsite_missing: all.backup_offsite_missing };
}

/** Every known old generation: a list of event -> locale -> texts sets. */
export function knownOldTemplateSets(): Array<{ label: string; texts: Texts }> {
  const { gen1, gen2 } = legacyCoreTemplates();
  return [
    { label: 'seed 2026-05-23 (Multi Stores, no items)', texts: gen1 },
    { label: 'seed 2026-06-03 (Multi Stores)', texts: gen2 },
    {
      label: 'seed before the backup_offsite_missing token fix',
      texts: legacyBackupOffsiteMissing(),
    },
  ];
}
