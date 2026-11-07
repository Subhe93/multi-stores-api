// Plain, dependency-free HTML email templates. Each builder returns the subject
// plus html and text parts. Kept intentionally simple (inline styles) so they
// render across mail clients without a build step.

import type { MailAttachment } from './order-mail.helpers';

export interface EmailParts {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'ShopsDoor';

// Escape interpolated values as defense-in-depth, so a future user-controlled
// field can't inject markup into the email body or break out of an attribute.
export function esc(s: string | number | boolean | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Branding an order email carries. A customer buying from a creator's shop
 * should see that shop's name and logo, not the platform's — especially once
 * the mail is sent from the shop's own domain. Falls back to the platform
 * brand when a store hasn't been resolved.
 */
export interface EmailBrand {
  storeName?: string;
  storeLogoUrl?: string;
  /** Which store this message belongs to — selects its sender and templates. */
  storeId?: string;
  /** Order the message is about — recorded in the delivery log only. */
  orderId?: string;
  /** Variables shared by every order template (totals, address, dates, …). */
  extraVars?: Record<string, string>;
  /** Files attached to the message (invoices app); omitted when none. */
  attachments?: MailAttachment[];
  /** Admin-configured platform name (PlatformConfig.platform_name) — used when
   *  no store brand applies, instead of the hardcoded fallback. */
  platformName?: string;
}

function layout(
  title: string,
  bodyHtml: string,
  brand?: EmailBrand,
  dir: 'ltr' | 'rtl' = 'ltr',
): string {
  const name = brand?.storeName || brand?.platformName || BRAND;
  const header = brand?.storeLogoUrl
    ? `<div style="text-align:center;margin-bottom:20px;"><img src="${esc(
        brand.storeLogoUrl,
      )}" alt="${esc(name)}" style="max-height:44px;max-width:200px;" /></div>`
    : '';
  // Only RTL emails carry a direction, so every LTR email stays byte-identical.
  const htmlAttrs = dir === 'rtl' ? ' dir="rtl"' : '';
  return `<!doctype html>
<html${htmlAttrs}>
  <body${htmlAttrs} style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
    <div style="max-width:520px;margin:0 auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">
        ${header}
        <h1 style="font-size:18px;margin:0 0 16px;">${title}</h1>
        ${bodyHtml}
      </div>
      <p style="font-size:11px;color:#a1a1aa;text-align:center;margin-top:16px;">${esc(name)}</p>
    </div>
  </body>
</html>`;
}

function button(label: string, url: string): string {
  return `<a href="${esc(url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">${esc(label)}</a>`;
}

/** The shared layout / button, for builders living in other files. */
export const layoutEmail = layout;
export const emailButton = button;

/**
 * Built-in wording of the account emails per locale (the admin DB templates
 * win when they exist). Swedish added for the Namez store (Phase 3.4); other
 * locales fall back to English.
 */
const ACCOUNT_TEXT: Record<
  string,
  {
    resetSubject: (name: string) => string;
    resetTitle: string;
    resetBody: string;
    resetButton: string;
    resetIgnore: string;
    resetText: (name: string, url: string) => string;
    welcomeSubject: (name: string) => string;
    welcomeGreeting: (name?: string) => string;
    welcomeBody: (store: boolean) => string;
    welcomeButton: string;
    welcomeText: (name: string, url?: string) => string;
  }
> = {
  en: {
    resetSubject: (name) => `Reset your ${name} password`,
    resetTitle: 'Reset your password',
    resetBody:
      'We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.',
    resetButton: 'Reset password',
    resetIgnore:
      "If you didn't request this, you can safely ignore this email.",
    resetText: (name, url) =>
      `Reset your ${name} password.\n\nOpen this link to choose a new password (expires in 1 hour):\n${url}\n\nIf you didn't request this, ignore this email.`,
    welcomeSubject: (name) => `Welcome to ${name}`,
    welcomeGreeting: (name) => (name ? `Hi ${esc(name)},` : 'Hi there,'),
    welcomeBody: (store) =>
      store
        ? "we're glad you're here. Your account is ready — you can follow your orders and manage your addresses any time."
        : "we're glad you're here. Your account is ready — start exploring stores and products built by independent creators.",
    welcomeButton: 'Sign in',
    welcomeText: (name, url) =>
      `Welcome to ${name}!\n\nYour account is ready.${url ? `\n\nSign in: ${url}` : ''}`,
  },
  sv: {
    resetSubject: (name) => `Återställ ditt lösenord hos ${name}`,
    resetTitle: 'Återställ ditt lösenord',
    resetBody:
      'Vi har fått en begäran om att återställa ditt lösenord. Klicka på knappen nedan för att välja ett nytt. Länken gäller i 1 timme.',
    resetButton: 'Återställ lösenord',
    resetIgnore: 'Om du inte begärde detta kan du bortse från det här mejlet.',
    resetText: (name, url) =>
      `Återställ ditt lösenord hos ${name}.\n\nÖppna länken för att välja ett nytt lösenord (gäller i 1 timme):\n${url}\n\nOm du inte begärde detta kan du bortse från mejlet.`,
    welcomeSubject: (name) => `Välkommen till ${name}`,
    welcomeGreeting: (name) => (name ? `Hej ${esc(name)},` : 'Hej,'),
    welcomeBody: (store) =>
      store
        ? 'vad roligt att du är här. Ditt konto är klart – du kan följa dina beställningar och hantera dina adresser när som helst.'
        : 'vad roligt att du är här. Ditt konto är klart – börja utforska butiker och produkter från oberoende kreatörer.',
    welcomeButton: 'Logga in',
    welcomeText: (name, url) =>
      `Välkommen till ${name}!\n\nDitt konto är klart.${url ? `\n\nLogga in: ${url}` : ''}`,
  },
};

function accountText(locale?: string | null) {
  const key = (locale ?? 'en').toLowerCase().split('-')[0];
  return ACCOUNT_TEXT[key] ?? ACCOUNT_TEXT.en;
}

export function passwordResetEmail(
  resetUrl: string,
  brand?: EmailBrand,
  locale?: string | null,
): EmailParts {
  const name = brand?.storeName || brand?.platformName || BRAND;
  const t = accountText(locale);
  return {
    subject: t.resetSubject(name),
    html: layout(
      t.resetTitle,
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         ${t.resetBody}
       </p>
       <p style="margin:20px 0;">${button(t.resetButton, resetUrl)}</p>
       <p style="font-size:12px;color:#71717a;">${t.resetIgnore}</p>`,
      brand,
    ),
    text: t.resetText(name, resetUrl),
  };
}

// ── Order emails ────────────────────────────────────────────────────────────
// All order email builders accept a pre-rendered itemsHtml/itemsText block so
// the template doesn't need a loop construct. Helpers in order-mail.helpers.ts
// produce those blocks from the loaded order.

/**
 * The tax rows under a total: one <p> per itemized line, falling back to
 * the joined text so a caller passing only `taxLine` still renders.
 */
function taxRows(
  data: { taxLine?: string; taxLines?: string[] },
  extraStyle = '',
): string {
  const lines = data.taxLines?.length
    ? data.taxLines
    : data.taxLine
      ? data.taxLine.split('\n').filter(Boolean)
      : [];
  return lines
    .map(
      (line, i) =>
        `<p style="font-size:12px;color:#71717a;margin-bottom:2px;${i === 0 ? extraStyle : ''}">${esc(line)}</p>`,
    )
    .join('');
}

export interface OrderConfirmationData extends EmailBrand {
  orderNumber: string;
  total: string; // already formatted, e.g. "SEK 423.30"
  // "Shipping (Standard shipping): SEK 49.00" — empty when nothing to show.
  shippingLine?: string;
  // Joined tax text ("Inkl. Moms (25 %): SEK 84.66") — empty when untaxed.
  taxLine?: string;
  // One entry per rate, rendered as separate rows.
  taxLines?: string[];
  paid: boolean; // true = paid (card), false = cash on delivery
  orderUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

export function orderConfirmationEmail(
  data: OrderConfirmationData,
): EmailParts {
  const paymentLine = data.paid
    ? 'Your payment was received.'
    : 'You chose cash on delivery — please pay the courier on arrival.';
  const cta = data.orderUrl
    ? `<p style="margin:20px 0;">${button('View your order', data.orderUrl)}</p>`
    : '';
  const itemsHtml = data.itemsHtml || '';
  const itemsText = data.itemsText ? `\n\n${data.itemsText}` : '';
  return {
    subject: `Order ${data.orderNumber} confirmed`,
    html: layout(
      'Thanks for your order!',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         Your order <strong>${esc(data.orderNumber)}</strong> has been placed. ${paymentLine}
       </p>
       ${itemsHtml}
       ${data.shippingLine ? `<p style="font-size:13px;color:#3f3f46;margin-bottom:4px;">${esc(data.shippingLine)}</p>` : ''}
       <p style="font-size:14px;color:#3f3f46;">Total: <strong>${esc(data.total)}</strong></p>
       ${taxRows(data, 'margin-top:-8px;')}
       ${cta}`,
      data,
    ),
    text: `Thanks for your order!\n\nOrder ${data.orderNumber} has been placed. ${paymentLine}${itemsText}${
      data.shippingLine ? `\n${data.shippingLine}` : ''
    }\nTotal: ${data.total}${
      data.taxLine ? `\n${data.taxLine}` : ''
    }${data.orderUrl ? `\n\nView your order: ${data.orderUrl}` : ''}`,
  };
}

export interface OrderShippedData extends EmailBrand {
  orderNumber: string;
  trackingNumber?: string;
  trackingUrl?: string;
  orderUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

export function orderShippedEmail(data: OrderShippedData): EmailParts {
  const tracking = data.trackingNumber
    ? `<p style="font-size:14px;color:#3f3f46;">Tracking: <strong>${esc(data.trackingNumber)}</strong></p>`
    : '';
  const trackBtn = data.trackingUrl
    ? `<p style="margin:16px 0;">${button('Track your package', data.trackingUrl)}</p>`
    : '';
  const viewBtn = data.orderUrl
    ? `<p style="margin:8px 0 20px;">${button('View your order', data.orderUrl)}</p>`
    : '';
  return {
    subject: `Your order ${data.orderNumber} is on the way`,
    html: layout(
      'Your order has shipped',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         Good news — your order <strong>${esc(data.orderNumber)}</strong> has been shipped.
       </p>
       ${data.itemsHtml || ''}
       ${tracking}
       ${trackBtn}
       ${viewBtn}`,
      data,
    ),
    text:
      `Your order ${data.orderNumber} has shipped.` +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.trackingNumber ? `\n\nTracking: ${data.trackingNumber}` : '') +
      (data.trackingUrl ? `\nTrack: ${data.trackingUrl}` : '') +
      (data.orderUrl ? `\nView order: ${data.orderUrl}` : ''),
  };
}

export interface OrderDeliveredData extends EmailBrand {
  orderNumber: string;
  orderUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

export function orderDeliveredEmail(data: OrderDeliveredData): EmailParts {
  const cta = data.orderUrl
    ? `<p style="margin:20px 0;">${button('View your order', data.orderUrl)}</p>`
    : '';
  return {
    subject: `Your order ${data.orderNumber} has been delivered`,
    html: layout(
      'Delivered!',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         Your order <strong>${esc(data.orderNumber)}</strong> has been marked as delivered. We hope you love it.
       </p>
       ${data.itemsHtml || ''}
       ${cta}`,
      data,
    ),
    text:
      `Your order ${data.orderNumber} has been delivered.` +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderUrl ? `\n\nView order: ${data.orderUrl}` : ''),
  };
}

export interface OrderCancelledData extends EmailBrand {
  orderNumber: string;
  reason?: string;
  orderUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

export function orderCancelledEmail(data: OrderCancelledData): EmailParts {
  const reasonHtml = data.reason
    ? `<p style="font-size:13px;color:#71717a;">Reason: ${esc(data.reason)}</p>`
    : '';
  const cta = data.orderUrl
    ? `<p style="margin:20px 0;">${button('View your order', data.orderUrl)}</p>`
    : '';
  return {
    subject: `Order ${data.orderNumber} cancelled`,
    html: layout(
      'Your order has been cancelled',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         Order <strong>${esc(data.orderNumber)}</strong> was cancelled. If you were charged, the refund is being processed.
       </p>
       ${reasonHtml}
       ${data.itemsHtml || ''}
       ${cta}`,
      data,
    ),
    text:
      `Order ${data.orderNumber} has been cancelled.` +
      (data.reason ? `\nReason: ${data.reason}` : '') +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderUrl ? `\n\nView order: ${data.orderUrl}` : ''),
  };
}

export interface OrderRefundedData extends EmailBrand {
  orderNumber: string;
  refundAmount?: string;
  orderUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

export function orderRefundedEmail(data: OrderRefundedData): EmailParts {
  const amountHtml = data.refundAmount
    ? `<p style="font-size:14px;color:#3f3f46;">Refunded amount: <strong>${esc(data.refundAmount)}</strong></p>`
    : '';
  const cta = data.orderUrl
    ? `<p style="margin:20px 0;">${button('View your order', data.orderUrl)}</p>`
    : '';
  return {
    subject: `Refund processed for order ${data.orderNumber}`,
    html: layout(
      'Refund processed',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         A refund has been processed for order <strong>${esc(data.orderNumber)}</strong>. It may take a few business days to appear on your statement.
       </p>
       ${amountHtml}
       ${data.itemsHtml || ''}
       ${cta}`,
      data,
    ),
    text:
      `A refund has been processed for order ${data.orderNumber}.` +
      (data.refundAmount ? `\nRefunded: ${data.refundAmount}` : '') +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderUrl ? `\n\nView order: ${data.orderUrl}` : ''),
  };
}

export interface NewOrderOwnerData extends EmailBrand {
  orderNumber: string;
  total: string;
  // "Shipping (Standard shipping): SEK 49.00" — empty when nothing to show.
  shippingLine?: string;
  // Joined tax text ("Inkl. Moms (25 %): SEK 84.66") — empty when untaxed.
  taxLine?: string;
  // One entry per rate, rendered as separate rows.
  taxLines?: string[];
  storeName?: string;
  customerName?: string;
  orderAdminUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

export function newOrderOwnerEmail(data: NewOrderOwnerData): EmailParts {
  const storeBit = data.storeName ? ` for ${esc(data.storeName)}` : '';
  const customerBit = data.customerName
    ? `<p style="font-size:13px;color:#71717a;">Customer: ${esc(data.customerName)}</p>`
    : '';
  const cta = data.orderAdminUrl
    ? `<p style="margin:20px 0;">${button('Open order', data.orderAdminUrl)}</p>`
    : '';
  return {
    subject: `New order ${data.orderNumber}${data.storeName ? ` — ${data.storeName}` : ''}`,
    html: layout(
      `New order received${storeBit}`,
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         You have a new order <strong>${esc(data.orderNumber)}</strong> totalling <strong>${esc(data.total)}</strong>.
       </p>
       ${data.shippingLine ? `<p style="font-size:13px;color:#3f3f46;">${esc(data.shippingLine)}</p>` : ''}
       ${taxRows(data)}
       ${customerBit}
       ${data.itemsHtml || ''}
       ${cta}`,
      data,
    ),
    text:
      `New order ${data.orderNumber}${data.storeName ? ` for ${data.storeName}` : ''}. Total: ${data.total}.` +
      (data.shippingLine ? `\n${data.shippingLine}` : '') +
      (data.taxLine ? `\n${data.taxLine}` : '') +
      (data.customerName ? `\nCustomer: ${data.customerName}` : '') +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderAdminUrl ? `\n\nOpen: ${data.orderAdminUrl}` : ''),
  };
}

// ── Production app (M5.4) staff emails ────────────────────────────────────

export interface ProductionNewOrderData extends EmailBrand {
  orderNumber: string;
  itemsCount: number;
  checksCount: number;
  customerName?: string;
  orderAdminUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

/** "New order to produce: #… (n items, m checks)" — bundled default. */
export function productionNewOrderEmail(
  data: ProductionNewOrderData,
): EmailParts {
  const counts = `${data.itemsCount} ${data.itemsCount === 1 ? 'item' : 'items'}, ${data.checksCount} ${data.checksCount === 1 ? 'check' : 'checks'}`;
  const subject = `New order to produce: ${data.orderNumber} (${counts})`;
  const customerBit = data.customerName
    ? `<p style="font-size:13px;color:#71717a;">Customer: ${esc(data.customerName)}</p>`
    : '';
  const cta = data.orderAdminUrl
    ? `<p style="margin:20px 0;">${button('Open production', data.orderAdminUrl)}</p>`
    : '';
  return {
    subject,
    html: layout(
      'New order to produce',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         Order <strong>${esc(data.orderNumber)}</strong> is waiting for production: <strong>${esc(counts)}</strong>.
       </p>
       ${customerBit}
       ${data.itemsHtml || ''}
       ${cta}`,
      data,
    ),
    text:
      `${subject}.` +
      (data.customerName ? `\nCustomer: ${data.customerName}` : '') +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderAdminUrl ? `\n\nOpen: ${data.orderAdminUrl}` : ''),
  };
}

export interface ProductionDigestOrder {
  orderNumber: string;
  status: string;
  /** Localised order date. */
  placedOn: string;
  total: number;
  done: number;
  state: string;
  adminUrl?: string;
}

export interface ProductionDigestData extends EmailBrand {
  /** Localised date of the digest ("18 Oct 2026"). */
  dateLabel: string;
  orders: ProductionDigestOrder[];
  dashboardUrl?: string;
}

/** Daily list of the orders still in production — bundled default. */
export function productionDigestEmail(data: ProductionDigestData): EmailParts {
  const n = data.orders.length;
  const subject = `Production today: ${n} ${n === 1 ? 'order' : 'orders'} open (${data.dateLabel})`;
  const rows = data.orders
    .map(
      (o) => `<tr>
  <td style="padding:8px 6px;border-bottom:1px solid #e4e4e7;font-size:13px;">${
    o.adminUrl
      ? `<a href="${esc(o.adminUrl)}" style="color:#18181b;font-weight:600;">${esc(o.orderNumber)}</a>`
      : `<strong>${esc(o.orderNumber)}</strong>`
  }</td>
  <td style="padding:8px 6px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#71717a;">${esc(o.placedOn)}</td>
  <td style="padding:8px 6px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#71717a;">${esc(o.status)}</td>
  <td style="padding:8px 6px;border-bottom:1px solid #e4e4e7;font-size:12px;text-align:end;white-space:nowrap;">${o.done}/${o.total}</td>
</tr>`,
    )
    .join('');
  const cta = data.dashboardUrl
    ? `<p style="margin:20px 0;">${button('Open production', data.dashboardUrl)}</p>`
    : '';
  return {
    subject,
    html: layout(
      `Orders in production (${data.dateLabel})`,
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">${n} ${n === 1 ? 'order is' : 'orders are'} not finished yet.</p>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>
       ${cta}`,
      data,
    ),
    text:
      `${subject}\n\n` +
      data.orders
        .map(
          (o) =>
            `${o.orderNumber} · ${o.placedOn} · ${o.status} · ${o.done}/${o.total}${o.adminUrl ? ` · ${o.adminUrl}` : ''}`,
        )
        .join('\n') +
      (data.dashboardUrl ? `\n\nOpen: ${data.dashboardUrl}` : ''),
  };
}

export interface WelcomeData {
  name?: string;
  loginUrl?: string;
}

export function welcomeEmail(
  data: WelcomeData,
  brand?: EmailBrand,
  locale?: string | null,
): EmailParts {
  const store = !!brand?.storeName;
  const name = brand?.storeName || brand?.platformName || BRAND;
  const t = accountText(locale);
  const cta = data.loginUrl
    ? `<p style="margin:20px 0;">${button(t.welcomeButton, data.loginUrl)}</p>`
    : '';
  return {
    subject: t.welcomeSubject(name),
    html: layout(
      t.welcomeSubject(esc(name)),
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         ${t.welcomeGreeting(data.name)} ${t.welcomeBody(store)}
       </p>
       ${cta}`,
      brand,
    ),
    text: t.welcomeText(name, data.loginUrl),
  };
}

// ── Account created (auto-created account with credentials) ─────────────────

/**
 * Wording of the `account_created` email per locale. Tokens: {store},
 * {name}, {hours}. Values are escaped before they are put in, so a phrase
 * itself must never contain user input. Keep in sync with the seeded platform
 * template (prisma/seed.ts → account_created).
 */
export const ACCOUNT_CREATED_TEXT: Record<
  string,
  {
    subject: string;
    title: string;
    greeting: string;
    greetingNoName: string;
    intro: string;
    emailLabel: string;
    passwordLabel: string;
    button: string;
    validity: string;
    loginLead: string;
    loginLink: string;
    changePassword: string;
    ignore: string;
  }
> = {
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

export interface AccountCreatedData {
  name?: string;
  email: string;
  password: string;
  magicUrl: string;
  loginUrl: string;
  expiresHours: number;
}

/** Split/join token fill, so `$` patterns in values stay literal. */
function fill(phrase: string, tokens: Record<string, string>): string {
  return Object.entries(tokens).reduce(
    (out, [key, value]) => out.split(`{${key}}`).join(value),
    phrase,
  );
}

/**
 * Bundled `account_created` email: the login details of an account the
 * platform created for the customer, plus a one-time magic login button.
 * The password and the magic link each appear exactly once in the HTML.
 * Unknown locales fall back to English; Arabic renders right-to-left.
 */
export function accountCreatedEmail(
  data: AccountCreatedData,
  brand?: EmailBrand,
  locale?: string | null,
): EmailParts {
  const key = (locale ?? 'en').toLowerCase().split(/[-_]/)[0];
  const lang = ACCOUNT_CREATED_TEXT[key] ? key : 'en';
  const t = ACCOUNT_CREATED_TEXT[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const storeName = brand?.storeName || brand?.platformName || BRAND;
  const name = (data.name ?? '').trim();
  const hours = String(data.expiresHours);

  const htmlTokens = { store: esc(storeName), name: esc(name), hours };
  const textTokens = { store: storeName, name, hours };
  const greeting = name ? t.greeting : t.greetingNoName;
  const p = 'font-size:14px;line-height:1.6;color:#3f3f46;';
  const small = 'font-size:12px;line-height:1.6;color:#71717a;';
  const label = 'font-size:12px;color:#71717a;';
  const value =
    "font-family:'Courier New',Courier,monospace;font-size:15px;color:#18181b;";

  const html = layout(
    esc(t.title),
    `<p style="${p}margin:0 0 8px;">${fill(greeting, htmlTokens)}</p>
       <p style="${p}margin:0 0 16px;">${fill(t.intro, htmlTokens)}</p>
       <div style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:14px 16px;margin:0 0 20px;">
         <p style="${label}margin:0 0 2px;">${esc(t.emailLabel)}</p>
         <p style="margin:0 0 12px;"><span dir="ltr" style="${value}">${esc(data.email)}</span></p>
         <p style="${label}margin:0 0 2px;">${esc(t.passwordLabel)}</p>
         <p style="margin:0;"><span dir="ltr" style="${value}font-weight:600;letter-spacing:1px;user-select:all;-webkit-user-select:all;">${esc(data.password)}</span></p>
       </div>
       <p style="margin:0 0 8px;">${button(t.button, data.magicUrl)}</p>
       <p style="${small}margin:0 0 20px;">${fill(t.validity, htmlTokens)}</p>
       <p style="${p}margin:0 0 16px;">${esc(t.loginLead)} <a href="${esc(data.loginUrl)}" style="color:#18181b;font-weight:600;">${esc(t.loginLink)}</a></p>
       <p style="${small}margin:0 0 8px;">${esc(t.changePassword)}</p>
       <p style="${small}margin:0;">${esc(t.ignore)}</p>`,
    brand,
    dir,
  );

  const text = [
    fill(greeting, textTokens),
    '',
    fill(t.intro, textTokens),
    `${t.emailLabel}: ${data.email}`,
    `${t.passwordLabel}: ${data.password}`,
    '',
    `${t.button}: ${data.magicUrl}`,
    fill(t.validity, textTokens),
    '',
    `${t.loginLead} ${data.loginUrl}`,
    '',
    t.changePassword,
    t.ignore,
  ].join('\n');

  return { subject: fill(t.subject, textTokens), html, text };
}

// ── Customer login link (sent by the store owner from the dashboard) ────────

/**
 * Wording of the `customer_login_link` email per locale. Tokens: {store},
 * {name}, {hours}. Values are escaped before they are put in, so a phrase
 * itself must never contain user input.
 */
export const CUSTOMER_LOGIN_LINK_TEXT: Record<
  string,
  {
    subject: string;
    title: string;
    greeting: string;
    greetingNoName: string;
    intro: string;
    button: string;
    validity: string;
    loginLead: string;
    loginLink: string;
    ignore: string;
  }
> = {
  en: {
    subject: 'Your login link for {store}',
    title: 'Log in to {store}',
    greeting: 'Hi {name},',
    greetingNoName: 'Hi there,',
    intro: 'Use the button below to log in to your account at {store}.',
    button: 'Log in with one click',
    validity: 'This button is valid for {hours} hours and can be used once.',
    loginLead: 'You can also log in with your email and password:',
    loginLink: 'Log in',
    ignore: 'If you did not expect this email, you can ignore it.',
  },
  ar: {
    subject: 'رابط تسجيل الدخول إلى {store}',
    title: 'تسجيل الدخول إلى {store}',
    greeting: 'مرحباً {name}،',
    greetingNoName: 'مرحباً،',
    intro: 'استخدم الزر أدناه لتسجيل الدخول إلى حسابك في {store}.',
    button: 'تسجيل الدخول بنقرة واحدة',
    validity: 'هذا الزر صالح لمدة {hours} ساعة ويمكن استخدامه مرة واحدة فقط.',
    loginLead: 'يمكنك أيضاً تسجيل الدخول ببريدك الإلكتروني وكلمة المرور:',
    loginLink: 'تسجيل الدخول',
    ignore: 'إذا لم تكن تتوقع هذه الرسالة، يمكنك تجاهلها.',
  },
  tr: {
    subject: '{store} giriş bağlantınız',
    title: '{store} hesabınıza giriş yapın',
    greeting: 'Merhaba {name},',
    greetingNoName: 'Merhaba,',
    intro: '{store} hesabınıza giriş yapmak için aşağıdaki butonu kullanın.',
    button: 'Tek tıkla giriş yap',
    validity:
      'Bu buton {hours} saat geçerlidir ve yalnızca bir kez kullanılabilir.',
    loginLead: 'E-posta adresiniz ve şifrenizle de giriş yapabilirsiniz:',
    loginLink: 'Giriş yap',
    ignore: 'Bu e-postayı beklemiyorduysanız dikkate almayabilirsiniz.',
  },
  de: {
    subject: 'Ihr Anmeldelink für {store}',
    title: 'Bei {store} anmelden',
    greeting: 'Hallo {name},',
    greetingNoName: 'Hallo,',
    intro:
      'Mit dem Button unten melden Sie sich bei Ihrem Konto bei {store} an.',
    button: 'Mit einem Klick anmelden',
    validity:
      'Dieser Button ist {hours} Stunden gültig und kann einmal verwendet werden.',
    loginLead: 'Sie können sich auch mit E-Mail und Passwort anmelden:',
    loginLink: 'Anmelden',
    ignore:
      'Wenn Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren.',
  },
  fr: {
    subject: 'Votre lien de connexion à {store}',
    title: 'Connexion à {store}',
    greeting: 'Bonjour {name},',
    greetingNoName: 'Bonjour,',
    intro:
      'Utilisez le bouton ci-dessous pour vous connecter à votre compte sur {store}.',
    button: 'Se connecter en un clic',
    validity:
      'Ce bouton est valable {hours} heures et ne peut être utilisé qu’une seule fois.',
    loginLead:
      'Vous pouvez aussi vous connecter avec votre e-mail et votre mot de passe :',
    loginLink: 'Se connecter',
    ignore: 'Si vous n’attendiez pas cet e-mail, vous pouvez l’ignorer.',
  },
  sv: {
    subject: 'Din inloggningslänk till {store}',
    title: 'Logga in hos {store}',
    greeting: 'Hej {name},',
    greetingNoName: 'Hej,',
    intro: 'Använd knappen nedan för att logga in på ditt konto hos {store}.',
    button: 'Logga in med ett klick',
    validity: 'Knappen gäller i {hours} timmar och kan användas en gång.',
    loginLead: 'Du kan också logga in med din e-post och ditt lösenord:',
    loginLink: 'Logga in',
    ignore: 'Om du inte väntade dig det här mejlet kan du bortse från det.',
  },
};

export interface CustomerLoginLinkData {
  name?: string;
  magicUrl: string;
  loginUrl: string;
  expiresHours: number;
}

/**
 * Bundled `customer_login_link` email: a one-time magic login button for an
 * existing customer account, sent by the store owner. The magic link appears
 * exactly once in the HTML. Unknown locales fall back to English; Arabic
 * renders right-to-left.
 */
export function customerLoginLinkEmail(
  data: CustomerLoginLinkData,
  brand?: EmailBrand,
  locale?: string | null,
): EmailParts {
  const key = (locale ?? 'en').toLowerCase().split(/[-_]/)[0];
  const lang = CUSTOMER_LOGIN_LINK_TEXT[key] ? key : 'en';
  const t = CUSTOMER_LOGIN_LINK_TEXT[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const storeName = brand?.storeName || brand?.platformName || BRAND;
  const name = (data.name ?? '').trim();
  const hours = String(data.expiresHours);

  const htmlTokens = { store: esc(storeName), name: esc(name), hours };
  const textTokens = { store: storeName, name, hours };
  const greeting = name ? t.greeting : t.greetingNoName;
  const p = 'font-size:14px;line-height:1.6;color:#3f3f46;';
  const small = 'font-size:12px;line-height:1.6;color:#71717a;';

  const html = layout(
    fill(t.title, htmlTokens),
    `<p style="${p}margin:0 0 8px;">${fill(greeting, htmlTokens)}</p>
       <p style="${p}margin:0 0 16px;">${fill(t.intro, htmlTokens)}</p>
       <p style="margin:0 0 8px;">${button(t.button, data.magicUrl)}</p>
       <p style="${small}margin:0 0 20px;">${fill(t.validity, htmlTokens)}</p>
       <p style="${p}margin:0 0 16px;">${esc(t.loginLead)} <a href="${esc(data.loginUrl)}" style="color:#18181b;font-weight:600;">${esc(t.loginLink)}</a></p>
       <p style="${small}margin:0;">${esc(t.ignore)}</p>`,
    brand,
    dir,
  );

  const text = [
    fill(greeting, textTokens),
    '',
    fill(t.intro, textTokens),
    '',
    `${t.button}: ${data.magicUrl}`,
    fill(t.validity, textTokens),
    '',
    `${t.loginLead} ${data.loginUrl}`,
    '',
    t.ignore,
  ].join('\n');

  return { subject: fill(t.subject, textTokens), html, text };
}

// ── Security alerts ─────────────────────────────────────────────────────────
// Sent when payment keys or two-factor settings change. They never contain a
// secret value — only which fields changed, when, and from where.

export type SecurityAlertKind =
  | 'platform_keys_changed'
  | 'kustom_keys_changed'
  | 'stripe_disconnected'
  | 'stripe_own_key_changed'
  | 'stripe_own_key_revoked'
  | 'two_factor_enabled'
  | 'two_factor_disabled'
  | 'recovery_codes_regenerated'
  | 'account_locked'
  | 'recovery_code_used'
  | 'admin_account_created';

export interface SecurityAlertData {
  kind: SecurityAlertKind;
  actorEmail: string;
  /** Field NAMES that changed (never values). */
  fields?: string[];
  at: Date;
  ip?: string | null;
  userAgent?: string | null;
  platformName?: string;
  /** Call-to-action link (button) — `stripe_own_key_revoked` only. */
  actionUrl?: string;
}

interface SecurityText {
  subject: Record<SecurityAlertKind, string>;
  body: Record<SecurityAlertKind, string>;
  by: string;
  fields: string;
  when: string;
  ip: string;
  device: string;
  notYou: string;
  /** Footer of `stripe_own_key_revoked` (what to do), instead of notYou. */
  reconnect: string;
  /** Button label of `stripe_own_key_revoked` (links to `actionUrl`). */
  reconnectButton: string;
  dir: 'ltr' | 'rtl';
}

const SECURITY_TEXT: Record<string, SecurityText> = {
  en: {
    subject: {
      platform_keys_changed:
        'Security alert: platform payment keys were changed',
      kustom_keys_changed:
        'Security alert: your Kustom payment credentials were changed',
      stripe_disconnected:
        'Security alert: your Stripe account was disconnected',
      stripe_own_key_changed: 'Security alert: the Stripe key of your store was changed',
      stripe_own_key_revoked: 'Action needed: your Stripe key stopped working',
      two_factor_enabled: 'Two-factor authentication was turned on',
      two_factor_disabled:
        'Security alert: two-factor authentication was turned off',
      recovery_codes_regenerated: 'New two-factor recovery codes were created',
      account_locked: 'Security alert: too many failed verification attempts',
      recovery_code_used: 'Security alert: a recovery code was used',
      admin_account_created:
        'Security alert: a new administrator account was created',
    },
    body: {
      platform_keys_changed:
        "The platform's Stripe payment settings were changed.",
      kustom_keys_changed:
        'The Kustom credentials used to receive payments for your store were changed.',
      stripe_disconnected:
        'The Stripe account that receives your payouts was disconnected.',
      stripe_own_key_changed: 'The Stripe key your store uses to receive card payments on your own Stripe account was connected, replaced or removed.',
      stripe_own_key_revoked: 'Stripe rejected the restricted key of your store (it was revoked, expired or deleted). Card payments are paused until you connect a new key.',
      two_factor_enabled:
        'Two-factor authentication is now required to sign in to your account.',
      two_factor_disabled:
        'Your account no longer asks for a two-factor code when you sign in.',
      recovery_codes_regenerated:
        'Your previous recovery codes no longer work.',
      account_locked:
        'Verification on your account was locked for 15 minutes after 5 wrong codes or passwords.',
      recovery_code_used:
        'One of your two-factor recovery codes was just used to verify your account. Each code works only once.',
      admin_account_created:
        'A new administrator account was created on the platform.',
    },
    by: 'Account',
    fields: 'Changed',
    when: 'Time (UTC)',
    ip: 'IP address',
    device: 'Device',
    reconnect: 'Create a new restricted key in your Stripe Dashboard and connect it under Settings > Payments. Other payment methods keep working meanwhile.',
    reconnectButton: 'Reconnect your Stripe key',
    notYou:
      "If this wasn't you, change your password immediately, turn on two-factor authentication and check your payment settings.",
    dir: 'ltr',
  },
  ar: {
    subject: {
      platform_keys_changed: 'تنبيه أمني: تم تغيير مفاتيح الدفع الخاصة بالمنصة',
      kustom_keys_changed:
        'تنبيه أمني: تم تغيير بيانات اعتماد Kustom الخاصة بك',
      stripe_disconnected: 'تنبيه أمني: تم فصل حساب Stripe الخاص بك',
      stripe_own_key_changed: 'تنبيه أمني: تم تغيير مفتاح Stripe الخاص بمتجرك',
      stripe_own_key_revoked: 'إجراء مطلوب: مفتاح Stripe الخاص بك توقف عن العمل',
      two_factor_enabled: 'تم تفعيل المصادقة الثنائية',
      two_factor_disabled: 'تنبيه أمني: تم إيقاف المصادقة الثنائية',
      recovery_codes_regenerated:
        'تم إنشاء رموز استرداد جديدة للمصادقة الثنائية',
      account_locked: 'تنبيه أمني: محاولات تحقق فاشلة كثيرة',
      recovery_code_used: 'تنبيه أمني: تم استخدام رمز استرداد',
      admin_account_created: 'تنبيه أمني: تم إنشاء حساب مدير جديد',
    },
    body: {
      platform_keys_changed:
        'تم تغيير إعدادات الدفع عبر Stripe الخاصة بالمنصة.',
      kustom_keys_changed:
        'تم تغيير بيانات Kustom المستخدمة لاستقبال مدفوعات متجرك.',
      stripe_disconnected: 'تم فصل حساب Stripe الذي تُحوَّل إليه أرباحك.',
      stripe_own_key_changed: 'تم ربط أو استبدال أو إزالة مفتاح Stripe الذي يستخدمه متجرك لاستقبال مدفوعات البطاقات على حساب Stripe الخاص بك.',
      stripe_own_key_revoked: 'رفض Stripe المفتاح المقيّد لمتجرك (تم إلغاؤه أو انتهت صلاحيته أو حُذف). تم إيقاف مدفوعات البطاقات مؤقتاً حتى تربط مفتاحاً جديداً.',
      two_factor_enabled:
        'أصبح رمز المصادقة الثنائية مطلوباً لتسجيل الدخول إلى حسابك.',
      two_factor_disabled:
        'لم يعد حسابك يطلب رمز المصادقة الثنائية عند تسجيل الدخول.',
      recovery_codes_regenerated: 'رموز الاسترداد السابقة لم تعد صالحة.',
      account_locked:
        'تم قفل التحقق في حسابك لمدة 15 دقيقة بعد 5 رموز أو كلمات مرور خاطئة.',
      recovery_code_used:
        'تم للتو استخدام أحد رموز الاسترداد للتحقق من حسابك. كل رمز يعمل مرة واحدة فقط.',
      admin_account_created: 'تم إنشاء حساب مدير جديد على المنصة.',
    },
    by: 'الحساب',
    fields: 'ما تغيّر',
    when: 'الوقت (UTC)',
    ip: 'عنوان IP',
    device: 'الجهاز',
    reconnect: 'أنشئ مفتاحاً مقيّداً جديداً من لوحة تحكم Stripe واربطه من الإعدادات > المدفوعات. طرق الدفع الأخرى تبقى تعمل في هذه الأثناء.',
    reconnectButton: 'أعد ربط مفتاح Stripe',
    notYou:
      'إذا لم تكن أنت من قام بذلك، غيّر كلمة المرور فوراً، وفعّل المصادقة الثنائية، وراجع إعدادات الدفع.',
    dir: 'rtl',
  },
  sv: {
    subject: {
      platform_keys_changed:
        'Säkerhetsvarning: plattformens betalnyckel har ändrats',
      kustom_keys_changed:
        'Säkerhetsvarning: dina Kustom-uppgifter har ändrats',
      stripe_disconnected:
        'Säkerhetsvarning: ditt Stripe-konto har kopplats bort',
      stripe_own_key_changed: 'Säkerhetsvarning: butikens Stripe-nyckel har ändrats',
      stripe_own_key_revoked: 'Åtgärd krävs: din Stripe-nyckel slutade fungera',
      two_factor_enabled: 'Tvåstegsverifiering har aktiverats',
      two_factor_disabled:
        'Säkerhetsvarning: tvåstegsverifiering har stängts av',
      recovery_codes_regenerated: 'Nya återställningskoder har skapats',
      account_locked:
        'Säkerhetsvarning: för många misslyckade verifieringsförsök',
      recovery_code_used: 'Säkerhetsvarning: en återställningskod har använts',
      admin_account_created:
        'Säkerhetsvarning: ett nytt administratörskonto har skapats',
    },
    body: {
      platform_keys_changed:
        'Plattformens Stripe-betalinställningar har ändrats.',
      kustom_keys_changed:
        'Kustom-uppgifterna som tar emot betalningar för din butik har ändrats.',
      stripe_disconnected:
        'Stripe-kontot som tar emot dina utbetalningar har kopplats bort.',
      stripe_own_key_changed: 'Stripe-nyckeln som din butik använder för att ta emot kortbetalningar på ditt eget Stripe-konto har kopplats, bytts ut eller tagits bort.',
      stripe_own_key_revoked: 'Stripe avvisade butikens begränsade nyckel (den har återkallats, gått ut eller raderats). Kortbetalningar är pausade tills du kopplar en ny nyckel.',
      two_factor_enabled:
        'En tvåstegskod krävs nu för att logga in på ditt konto.',
      two_factor_disabled:
        'Ditt konto frågar inte längre efter en tvåstegskod vid inloggning.',
      recovery_codes_regenerated:
        'Dina tidigare återställningskoder fungerar inte längre.',
      account_locked:
        'Verifieringen på ditt konto låstes i 15 minuter efter 5 felaktiga koder eller lösenord.',
      recovery_code_used:
        'En av dina återställningskoder användes nyss för att verifiera ditt konto. Varje kod fungerar bara en gång.',
      admin_account_created:
        'Ett nytt administratörskonto har skapats på plattformen.',
    },
    by: 'Konto',
    fields: 'Ändrat',
    when: 'Tid (UTC)',
    ip: 'IP-adress',
    device: 'Enhet',
    reconnect: 'Skapa en ny begränsad nyckel i Stripe Dashboard och koppla den under Inställningar > Betalningar. Andra betalsätt fungerar under tiden.',
    reconnectButton: 'Koppla din Stripe-nyckel igen',
    notYou:
      'Om det inte var du: byt lösenord direkt, aktivera tvåstegsverifiering och kontrollera dina betalinställningar.',
    dir: 'ltr',
  },
  tr: {
    subject: {
      platform_keys_changed:
        'Güvenlik uyarısı: platformun ödeme anahtarları değiştirildi',
      kustom_keys_changed:
        'Güvenlik uyarısı: Kustom ödeme bilgileriniz değiştirildi',
      stripe_disconnected:
        'Güvenlik uyarısı: Stripe hesabınızın bağlantısı kesildi',
      stripe_own_key_changed: 'Güvenlik uyarısı: mağazanızın Stripe anahtarı değiştirildi',
      stripe_own_key_revoked: 'İşlem gerekli: Stripe anahtarınız çalışmayı durdurdu',
      two_factor_enabled: 'İki adımlı doğrulama açıldı',
      two_factor_disabled: 'Güvenlik uyarısı: iki adımlı doğrulama kapatıldı',
      recovery_codes_regenerated:
        'Yeni iki adımlı doğrulama kurtarma kodları oluşturuldu',
      account_locked:
        'Güvenlik uyarısı: çok fazla başarısız doğrulama denemesi',
      recovery_code_used: 'Güvenlik uyarısı: bir kurtarma kodu kullanıldı',
      admin_account_created:
        'Güvenlik uyarısı: yeni bir yönetici hesabı oluşturuldu',
    },
    body: {
      platform_keys_changed: 'Platformun Stripe ödeme ayarları değiştirildi.',
      kustom_keys_changed:
        'Mağazanızın ödemelerini almak için kullanılan Kustom bilgileri değiştirildi.',
      stripe_disconnected:
        'Ödemelerinizi alan Stripe hesabının bağlantısı kesildi.',
      stripe_own_key_changed: 'Mağazanızın kendi Stripe hesabınızda kart ödemesi almak için kullandığı Stripe anahtarı bağlandı, değiştirildi veya kaldırıldı.',
      stripe_own_key_revoked: 'Stripe mağazanızın kısıtlı anahtarını reddetti (iptal edildi, süresi doldu veya silindi). Yeni bir anahtar bağlayana kadar kart ödemeleri duraklatıldı.',
      two_factor_enabled:
        'Hesabınıza giriş için artık iki adımlı doğrulama kodu gerekiyor.',
      two_factor_disabled:
        'Hesabınız artık girişte iki adımlı doğrulama kodu istemiyor.',
      recovery_codes_regenerated:
        'Önceki kurtarma kodlarınız artık çalışmıyor.',
      account_locked:
        '5 hatalı kod veya şifreden sonra hesabınızdaki doğrulama 15 dakika kilitlendi.',
      recovery_code_used:
        'Kurtarma kodlarınızdan biri az önce hesabınızı doğrulamak için kullanıldı. Her kod yalnızca bir kez çalışır.',
      admin_account_created: 'Platformda yeni bir yönetici hesabı oluşturuldu.',
    },
    by: 'Hesap',
    fields: 'Değişenler',
    when: 'Zaman (UTC)',
    ip: 'IP adresi',
    device: 'Cihaz',
    reconnect: 'Stripe Dashboard üzerinden yeni bir kısıtlı anahtar oluşturun ve Ayarlar > Ödemeler bölümünden bağlayın. Diğer ödeme yöntemleri bu sırada çalışmaya devam eder.',
    reconnectButton: 'Stripe anahtarınızı yeniden bağlayın',
    notYou:
      'Bunu siz yapmadıysanız hemen şifrenizi değiştirin, iki adımlı doğrulamayı açın ve ödeme ayarlarınızı kontrol edin.',
    dir: 'ltr',
  },
  de: {
    subject: {
      platform_keys_changed:
        'Sicherheitswarnung: Die Zahlungsschlüssel der Plattform wurden geändert',
      kustom_keys_changed:
        'Sicherheitswarnung: Ihre Kustom-Zahlungsdaten wurden geändert',
      stripe_disconnected:
        'Sicherheitswarnung: Ihr Stripe-Konto wurde getrennt',
      stripe_own_key_changed: 'Sicherheitswarnung: Der Stripe-Schlüssel Ihres Shops wurde geändert',
      stripe_own_key_revoked: 'Handlung erforderlich: Ihr Stripe-Schlüssel funktioniert nicht mehr',
      two_factor_enabled: 'Zwei-Faktor-Authentifizierung wurde aktiviert',
      two_factor_disabled:
        'Sicherheitswarnung: Zwei-Faktor-Authentifizierung wurde deaktiviert',
      recovery_codes_regenerated:
        'Neue Wiederherstellungscodes wurden erstellt',
      account_locked:
        'Sicherheitswarnung: zu viele fehlgeschlagene Bestätigungsversuche',
      recovery_code_used:
        'Sicherheitswarnung: Ein Wiederherstellungscode wurde verwendet',
      admin_account_created:
        'Sicherheitswarnung: Ein neues Administratorkonto wurde erstellt',
    },
    body: {
      platform_keys_changed:
        'Die Stripe-Zahlungseinstellungen der Plattform wurden geändert.',
      kustom_keys_changed:
        'Die Kustom-Daten, über die Ihr Shop Zahlungen erhält, wurden geändert.',
      stripe_disconnected:
        'Das Stripe-Konto, das Ihre Auszahlungen erhält, wurde getrennt.',
      stripe_own_key_changed: 'Der Stripe-Schlüssel, mit dem Ihr Shop Kartenzahlungen auf Ihrem eigenen Stripe-Konto empfängt, wurde verbunden, ersetzt oder entfernt.',
      stripe_own_key_revoked: 'Stripe hat den eingeschränkten Schlüssel Ihres Shops abgelehnt (widerrufen, abgelaufen oder gelöscht). Kartenzahlungen sind pausiert, bis Sie einen neuen Schlüssel verbinden.',
      two_factor_enabled:
        'Für die Anmeldung bei Ihrem Konto ist jetzt ein Zwei-Faktor-Code erforderlich.',
      two_factor_disabled:
        'Ihr Konto fragt bei der Anmeldung nicht mehr nach einem Zwei-Faktor-Code.',
      recovery_codes_regenerated:
        'Ihre bisherigen Wiederherstellungscodes funktionieren nicht mehr.',
      account_locked:
        'Die Bestätigung Ihres Kontos wurde nach 5 falschen Codes oder Passwörtern für 15 Minuten gesperrt.',
      recovery_code_used:
        'Einer Ihrer Wiederherstellungscodes wurde gerade zur Bestätigung Ihres Kontos verwendet. Jeder Code funktioniert nur einmal.',
      admin_account_created:
        'Auf der Plattform wurde ein neues Administratorkonto erstellt.',
    },
    by: 'Konto',
    fields: 'Geändert',
    when: 'Zeit (UTC)',
    ip: 'IP-Adresse',
    device: 'Gerät',
    reconnect: 'Erstellen Sie im Stripe-Dashboard einen neuen eingeschränkten Schlüssel und verbinden Sie ihn unter Einstellungen > Zahlungen. Andere Zahlungsarten funktionieren weiterhin.',
    reconnectButton: 'Stripe-Schlüssel neu verbinden',
    notYou:
      'Wenn Sie das nicht waren, ändern Sie sofort Ihr Passwort, aktivieren Sie die Zwei-Faktor-Authentifizierung und prüfen Sie Ihre Zahlungseinstellungen.',
    dir: 'ltr',
  },
  fr: {
    subject: {
      platform_keys_changed:
        'Alerte de sécurité : les clés de paiement de la plateforme ont été modifiées',
      kustom_keys_changed:
        'Alerte de sécurité : vos identifiants de paiement Kustom ont été modifiés',
      stripe_disconnected:
        'Alerte de sécurité : votre compte Stripe a été déconnecté',
      stripe_own_key_changed: 'Alerte de sécurité : la clé Stripe de votre boutique a été modifiée',
      stripe_own_key_revoked: 'Action requise : votre clé Stripe ne fonctionne plus',
      two_factor_enabled: "L'authentification à deux facteurs a été activée",
      two_factor_disabled:
        "Alerte de sécurité : l'authentification à deux facteurs a été désactivée",
      recovery_codes_regenerated:
        'De nouveaux codes de récupération ont été créés',
      account_locked:
        'Alerte de sécurité : trop de tentatives de vérification échouées',
      recovery_code_used:
        'Alerte de sécurité : un code de récupération a été utilisé',
      admin_account_created:
        'Alerte de sécurité : un nouveau compte administrateur a été créé',
    },
    body: {
      platform_keys_changed:
        'Les paramètres de paiement Stripe de la plateforme ont été modifiés.',
      kustom_keys_changed:
        'Les identifiants Kustom utilisés pour recevoir les paiements de votre boutique ont été modifiés.',
      stripe_disconnected:
        'Le compte Stripe qui reçoit vos versements a été déconnecté.',
      stripe_own_key_changed: 'La clé Stripe utilisée par votre boutique pour recevoir les paiements par carte sur votre propre compte Stripe a été connectée, remplacée ou supprimée.',
      stripe_own_key_revoked: 'Stripe a refusé la clé restreinte de votre boutique (révoquée, expirée ou supprimée). Les paiements par carte sont suspendus jusqu’à ce que vous connectiez une nouvelle clé.',
      two_factor_enabled:
        'Un code à deux facteurs est désormais requis pour vous connecter à votre compte.',
      two_factor_disabled:
        'Votre compte ne demande plus de code à deux facteurs à la connexion.',
      recovery_codes_regenerated:
        'Vos anciens codes de récupération ne fonctionnent plus.',
      account_locked:
        'La vérification de votre compte a été bloquée pendant 15 minutes après 5 codes ou mots de passe erronés.',
      recovery_code_used:
        "L'un de vos codes de récupération vient d'être utilisé pour vérifier votre compte. Chaque code ne fonctionne qu'une fois.",
      admin_account_created:
        'Un nouveau compte administrateur a été créé sur la plateforme.',
    },
    by: 'Compte',
    fields: 'Modifié',
    when: 'Heure (UTC)',
    ip: 'Adresse IP',
    device: 'Appareil',
    reconnect: 'Créez une nouvelle clé restreinte dans le Dashboard Stripe et connectez-la dans Paramètres > Paiements. Les autres moyens de paiement continuent de fonctionner.',
    reconnectButton: 'Reconnecter votre clé Stripe',
    notYou:
      "Si ce n'était pas vous, changez immédiatement votre mot de passe, activez l'authentification à deux facteurs et vérifiez vos paramètres de paiement.",
    dir: 'ltr',
  },
};

export function securityAlertEmail(
  data: SecurityAlertData,
  locale?: string | null,
): EmailParts {
  const key = (locale ?? 'en').toLowerCase().split('-')[0];
  const t = SECURITY_TEXT[key] ?? SECURITY_TEXT.en;
  const when = data.at.toISOString().replace('T', ' ').slice(0, 19);
  const rows: Array<[string, string]> = [[t.by, data.actorEmail]];
  if (data.fields?.length) rows.push([t.fields, data.fields.join(', ')]);
  rows.push([t.when, when]);
  if (data.ip) rows.push([t.ip, data.ip]);
  if (data.userAgent) rows.push([t.device, data.userAgent.slice(0, 160)]);

  const table = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:#71717a;white-space:nowrap;vertical-align:top;">${esc(label)}</td><td style="padding:4px 0;font-size:13px;color:#18181b;word-break:break-word;"><bdi>${esc(value)}</bdi></td></tr>`,
    )
    .join('');
  const revoked = data.kind === 'stripe_own_key_revoked';
  const footer = revoked ? t.reconnect : t.notYou;
  const action =
    revoked && data.actionUrl
      ? `<p style="margin:20px 0;">${button(t.reconnectButton, data.actionUrl)}</p>`
      : '';
  const html = layout(
    esc(t.subject[data.kind]),
    `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">${esc(t.body[data.kind])}</p>
     <table style="border-collapse:collapse;margin:16px 0;">${table}</table>
     <p style="font-size:13px;line-height:1.6;color:#b91c1c;">${esc(footer)}</p>${action}`,
    { platformName: data.platformName },
    t.dir,
  );
  const text = [
    t.subject[data.kind],
    '',
    t.body[data.kind],
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    footer,
    ...(action ? ['', `${t.reconnectButton}: ${data.actionUrl}`] : []),
  ].join('\n');
  return { subject: t.subject[data.kind], html, text };
}
