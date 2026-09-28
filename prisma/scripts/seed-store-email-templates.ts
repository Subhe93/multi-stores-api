/**
 * Installs a branded set of order email templates for one INDEPENDENT store
 * (StoreNotificationTemplate rows), in Swedish and English:
 * order_confirmation, order_shipped, order_delivered, order_cancelled,
 * order_refunded and new_order_owner.
 *
 * Colours come from the store's theme (theme_customizations.colors). Products,
 * prices and totals are the pre-rendered {{items_html}} / {{totals_html}}
 * blocks, so they always match the order. Existing rows are written to a JSON
 * backup before they are replaced.
 *
 * Run with:
 *   npx ts-node prisma/scripts/seed-store-email-templates.ts \
 *     --slug naturalcotton --display-name "Natural Cotton" --company "Namez AB"
 *
 * Options:
 *   --preview <dir>   also write rendered sample HTML files there
 *   --dry-run         build (and preview) only; do not touch the database
 */
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { substitute } from '../../src/modules/notification-templates/notification-templates.service';

type Locale = 'sv' | 'en';
const LOCALES: Locale[] = ['sv', 'en'];

interface Brand {
  name: string;
  company: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  primary: string;
  primaryContrast: string;
  surface: string;
  background: string;
}

interface EventCopy {
  subject: string;
  preheader: string;
  eyebrow: string;
  title: string;
  intro: string;
}

interface Copy {
  orderNumber: string;
  date: string;
  payment: string;
  yourOrder: string;
  deliveryAddress: string;
  viewOrder: string;
  openOrder: string;
  trackPackage: string;
  trackingNumber: string;
  reason: string;
  refunded: string;
  customer: string;
  visit: string;
  thanks: string;
  events: Record<string, EventCopy>;
}

const COPY: Record<Locale, Copy> = {
  sv: {
    orderNumber: 'Ordernummer',
    date: 'Datum',
    payment: 'Betalning',
    yourOrder: 'Din beställning',
    deliveryAddress: 'Leveransadress',
    viewOrder: 'Visa din beställning',
    openOrder: 'Öppna beställningen',
    trackPackage: 'Spåra ditt paket',
    trackingNumber: 'Spårningsnummer',
    reason: 'Anledning',
    refunded: 'Återbetalat belopp',
    customer: 'Kund',
    visit: 'Besök butiken',
    thanks: 'Tack för att du handlar hos oss.',
    events: {
      order_confirmation: {
        subject: 'Tack för din beställning! Order {{order_number}}',
        preheader: 'Vi har tagit emot din beställning {{order_number}}.',
        eyebrow: 'Orderbekräftelse',
        title:
          'Tack för din beställning{{#if customer_first_name}}, {{customer_first_name}}{{/if}}!',
        intro:
          'Vi har tagit emot din beställning och börjar förbereda den direkt. {{payment_line}} Du får ett nytt mejl så snart paketet har skickats.',
      },
      order_shipped: {
        subject: 'Din beställning {{order_number}} är på väg',
        preheader: 'Ditt paket har lämnat vårt lager.',
        eyebrow: 'Leveransbesked',
        title: 'Ditt paket är på väg',
        intro:
          '{{#if customer_first_name}}Hej {{customer_first_name}}! {{/if}}Goda nyheter: din beställning {{order_number}} har skickats och är på väg till dig.',
      },
      order_delivered: {
        subject: 'Din beställning {{order_number}} har levererats',
        preheader: 'Vi hoppas att du blir nöjd med ditt köp.',
        eyebrow: 'Levererad',
        title: 'Din beställning har levererats',
        intro:
          '{{#if customer_first_name}}Hej {{customer_first_name}}! {{/if}}Din beställning {{order_number}} har levererats. Vi hoppas att du kommer att trivas med dina nya plagg.',
      },
      order_cancelled: {
        subject: 'Din beställning {{order_number}} har makulerats',
        preheader: 'Din beställning har makulerats.',
        eyebrow: 'Makulerad order',
        title: 'Din beställning har makulerats',
        intro:
          '{{#if customer_first_name}}Hej {{customer_first_name}}. {{/if}}Din beställning {{order_number}} har makulerats. Om du redan har betalat återförs beloppet till samma betalsätt.',
      },
      order_refunded: {
        subject: 'Återbetalning för order {{order_number}}',
        preheader: 'Din återbetalning har genomförts.',
        eyebrow: 'Återbetalning',
        title: 'Din återbetalning är genomförd',
        intro:
          '{{#if customer_first_name}}Hej {{customer_first_name}}. {{/if}}Vi har gjort en återbetalning för din beställning {{order_number}}. Det kan ta några bankdagar innan beloppet syns på ditt konto.',
      },
      new_order_owner: {
        subject: 'Ny beställning {{order_number}} – {{total}}',
        preheader: '{{customer_name}} har lagt en beställning på {{total}}.',
        eyebrow: 'Ny beställning',
        title: 'Du har fått en ny beställning',
        intro:
          '{{#if customer_name}}{{customer_name}} har{{/if}}{{#unless customer_name}}En kund har{{/unless}} lagt en beställning på {{total}} i {{store_name}}.',
      },
    },
  },
  en: {
    orderNumber: 'Order number',
    date: 'Date',
    payment: 'Payment',
    yourOrder: 'Your order',
    deliveryAddress: 'Delivery address',
    viewOrder: 'View your order',
    openOrder: 'Open the order',
    trackPackage: 'Track your package',
    trackingNumber: 'Tracking number',
    reason: 'Reason',
    refunded: 'Refunded amount',
    customer: 'Customer',
    visit: 'Visit the store',
    thanks: 'Thank you for shopping with us.',
    events: {
      order_confirmation: {
        subject: 'Thank you for your order! Order {{order_number}}',
        preheader: 'We have received your order {{order_number}}.',
        eyebrow: 'Order confirmation',
        title:
          'Thank you for your order{{#if customer_first_name}}, {{customer_first_name}}{{/if}}!',
        intro:
          'We have received your order and are getting it ready. {{payment_line}} You will get another email as soon as your package has shipped.',
      },
      order_shipped: {
        subject: 'Your order {{order_number}} is on its way',
        preheader: 'Your package has left our warehouse.',
        eyebrow: 'Shipping update',
        title: 'Your package is on its way',
        intro:
          '{{#if customer_first_name}}Hi {{customer_first_name}}! {{/if}}Good news: your order {{order_number}} has shipped and is on its way to you.',
      },
      order_delivered: {
        subject: 'Your order {{order_number}} has been delivered',
        preheader: 'We hope you love your purchase.',
        eyebrow: 'Delivered',
        title: 'Your order has been delivered',
        intro:
          '{{#if customer_first_name}}Hi {{customer_first_name}}! {{/if}}Your order {{order_number}} has been delivered. We hope you enjoy your new pieces.',
      },
      order_cancelled: {
        subject: 'Your order {{order_number}} has been cancelled',
        preheader: 'Your order has been cancelled.',
        eyebrow: 'Order cancelled',
        title: 'Your order has been cancelled',
        intro:
          '{{#if customer_first_name}}Hi {{customer_first_name}}. {{/if}}Your order {{order_number}} has been cancelled. If you have already paid, the amount is returned to the same payment method.',
      },
      order_refunded: {
        subject: 'Refund for order {{order_number}}',
        preheader: 'Your refund has been processed.',
        eyebrow: 'Refund',
        title: 'Your refund has been processed',
        intro:
          '{{#if customer_first_name}}Hi {{customer_first_name}}. {{/if}}We have issued a refund for your order {{order_number}}. It can take a few business days before the amount shows on your account.',
      },
      new_order_owner: {
        subject: 'New order {{order_number}} – {{total}}',
        preheader: '{{customer_name}} placed an order for {{total}}.',
        eyebrow: 'New order',
        title: 'You have a new order',
        intro:
          '{{#if customer_name}}{{customer_name}}{{/if}}{{#unless customer_name}}A customer{{/unless}} placed an order for {{total}} in {{store_name}}.',
      },
    },
  },
};

const SERIF = "Georgia,'Times New Roman',Times,serif";
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function button(b: Brand, label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 0;">
  <tr>
    <td align="center" style="background:${b.primary};border-radius:2px;">
      <a href="${href}" style="display:inline-block;padding:14px 34px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${b.primaryContrast};text-decoration:none;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

function sectionTitle(b: Brand, label: string): string {
  return `<p style="margin:32px 0 4px;padding:0 0 10px;border-bottom:1px solid ${b.border};font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${b.text};">${esc(label)}</p>`;
}

function metaCell(b: Brand, label: string, value: string): string {
  return `<td width="33%" style="padding:14px 8px;vertical-align:top;text-align:center;">
      <p style="margin:0 0 4px;font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${b.muted};">${esc(label)}</p>
      <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.4;color:${b.text};">${value}</p>
    </td>`;
}

function meta(b: Brand, c: Copy): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0;background:${b.surface};border-radius:2px;">
  <tr>
    ${metaCell(b, c.orderNumber, '{{order_number}}')}
    ${metaCell(b, c.date, '{{order_date}}')}
    ${metaCell(b, c.payment, '{{payment_method}}')}
  </tr>
</table>`;
}

function infoBox(b: Brand, label: string, value: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;border:1px solid ${b.border};border-radius:2px;">
  <tr>
    <td style="padding:16px 18px;">
      <p style="margin:0 0 4px;font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${b.muted};">${esc(label)}</p>
      <p style="margin:0;font-family:${SANS};font-size:15px;font-weight:700;color:${b.text};">${value}</p>
    </td>
  </tr>
</table>`;
}

function address(b: Brand, c: Copy): string {
  return `{{#if shipping_address_html}}${sectionTitle(b, c.deliveryAddress)}
<p style="margin:12px 0 0;font-family:${SANS};font-size:13px;line-height:1.7;color:${b.text};">{{shipping_address_html}}</p>{{/if}}`;
}

function shell(
  b: Brand,
  locale: Locale,
  c: Copy,
  e: EventCopy,
  body: string,
): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${esc(b.name)}</title>
</head>
<body style="margin:0;padding:0;background:${b.surface};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${b.surface};">${e.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${b.surface};">
  <tr>
    <td align="center" style="padding:36px 12px 28px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
        <tr>
          <td align="center" style="padding:0 0 28px;">
            <a href="{{store_url}}" style="text-decoration:none;color:${b.text};">{{#if store_logo_url}}<img src="{{store_logo_url}}" alt="${esc(b.name)}" width="190" style="display:block;width:190px;max-width:60%;height:auto;border:0;margin:0 auto;" />{{/if}}{{#unless store_logo_url}}<span style="font-family:${SERIF};font-size:26px;letter-spacing:1px;color:${b.text};">${esc(b.name)}</span>{{/unless}}</a>
          </td>
        </tr>
        <tr>
          <td style="background:${b.background};border:1px solid ${b.border};border-radius:4px;padding:44px 40px 40px;font-family:${SANS};">
            <p style="margin:0 0 14px;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${b.accent};text-align:center;">${esc(e.eyebrow)}</p>
            <h1 style="margin:0 0 16px;font-family:${SERIF};font-size:28px;line-height:1.25;font-weight:400;color:${b.text};text-align:center;">${e.title}</h1>
            <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:#404040;text-align:center;">${e.intro}</p>
${body}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:28px 16px 0;">
            <p style="margin:0 0 8px;font-family:${SERIF};font-size:15px;color:${b.text};">${esc(c.thanks)}</p>
            <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;"><a href="{{store_url}}" style="color:${b.text};text-decoration:underline;">${esc(c.visit)}</a></p>
            <p style="margin:0;font-family:${SANS};font-size:11px;line-height:1.6;color:${b.muted};">${esc(b.name)}${b.company ? ` · ${esc(b.company)}` : ''}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function items(b: Brand, c: Copy): string {
  return `${sectionTitle(b, c.yourOrder)}
{{items_html}}`;
}

function htmlFor(event: string, b: Brand, locale: Locale): string {
  const c = COPY[locale];
  const e = c.events[event];
  switch (event) {
    case 'order_confirmation':
      return shell(
        b,
        locale,
        c,
        e,
        `${meta(b, c)}
${items(b, c)}
{{totals_html}}
${address(b, c)}
{{#if order_url}}${button(b, c.viewOrder, '{{order_url}}')}{{/if}}`,
      );
    case 'order_shipped':
      return shell(
        b,
        locale,
        c,
        e,
        `{{#if tracking_number}}${infoBox(b, c.trackingNumber, '{{tracking_number}}')}{{/if}}
{{#if tracking_url}}${button(b, c.trackPackage, '{{tracking_url}}')}{{/if}}
${items(b, c)}
${address(b, c)}
{{#unless tracking_url}}{{#if order_url}}${button(b, c.viewOrder, '{{order_url}}')}{{/if}}{{/unless}}`,
      );
    case 'order_delivered':
      return shell(
        b,
        locale,
        c,
        e,
        `${items(b, c)}
{{#if order_url}}${button(b, c.viewOrder, '{{order_url}}')}{{/if}}`,
      );
    case 'order_cancelled':
      return shell(
        b,
        locale,
        c,
        e,
        `{{#if reason}}${infoBox(b, c.reason, '{{reason}}')}{{/if}}
${items(b, c)}
{{#if order_url}}${button(b, c.viewOrder, '{{order_url}}')}{{/if}}`,
      );
    case 'order_refunded':
      return shell(
        b,
        locale,
        c,
        e,
        `{{#if refund_amount}}${infoBox(b, c.refunded, '{{refund_amount}}')}{{/if}}
${items(b, c)}
{{#if order_url}}${button(b, c.viewOrder, '{{order_url}}')}{{/if}}`,
      );
    case 'new_order_owner':
      return shell(
        b,
        locale,
        c,
        e,
        `${meta(b, c)}
${sectionTitle(b, c.customer)}
<p style="margin:12px 0 0;font-family:${SANS};font-size:13px;line-height:1.7;color:${b.text};">{{customer_name}}{{#if customer_email}}<br /><a href="mailto:{{customer_email}}" style="color:${b.text};">{{customer_email}}</a>{{/if}}</p>
${items(b, c)}
{{totals_html}}
${address(b, c)}
{{#if order_url}}${button(b, c.openOrder, '{{order_url}}')}{{/if}}`,
      );
    default:
      throw new Error(`Unknown event ${event}`);
  }
}

function textFor(event: string, b: Brand, locale: Locale): string {
  const c = COPY[locale];
  const e = c.events[event];
  const head = `${e.title}\n\n${e.intro}\n\n${c.orderNumber}: {{order_number}}\n${c.date}: {{order_date}}\n${c.payment}: {{payment_method}}\n`;
  const itemsText = `\n{{items_text}}\n`;
  const totals = `\n{{totals_text}}\n`;
  const addr = `{{#if shipping_address_text}}\n${c.deliveryAddress}:\n{{shipping_address_text}}\n{{/if}}`;
  const view = `{{#if order_url}}\n${event === 'new_order_owner' ? c.openOrder : c.viewOrder}: {{order_url}}\n{{/if}}`;
  const foot = `\n${b.name}${b.company ? ` · ${b.company}` : ''}\n{{store_url}}`;
  switch (event) {
    case 'order_confirmation':
      return head + itemsText + totals + addr + view + foot;
    case 'order_shipped':
      return (
        head +
        `{{#if tracking_number}}\n${c.trackingNumber}: {{tracking_number}}\n{{/if}}` +
        `{{#if tracking_url}}${c.trackPackage}: {{tracking_url}}\n{{/if}}` +
        itemsText +
        addr +
        view +
        foot
      );
    case 'order_cancelled':
      return (
        head +
        `{{#if reason}}\n${c.reason}: {{reason}}\n{{/if}}` +
        itemsText +
        view +
        foot
      );
    case 'order_refunded':
      return (
        head +
        `{{#if refund_amount}}\n${c.refunded}: {{refund_amount}}\n{{/if}}` +
        itemsText +
        view +
        foot
      );
    case 'new_order_owner':
      return (
        head +
        `\n${c.customer}: {{customer_name}}{{#if customer_email}} <{{customer_email}}>{{/if}}\n` +
        itemsText +
        totals +
        addr +
        view +
        foot
      );
    default:
      return head + itemsText + view + foot;
  }
}

const EVENTS = [
  'order_confirmation',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'order_refunded',
  'new_order_owner',
];

export function buildTemplates(brand: Brand) {
  return EVENTS.map((event) => {
    const subject: Record<string, string> = {};
    const body_html: Record<string, string> = {};
    const body_text: Record<string, string> = {};
    for (const locale of LOCALES) {
      subject[locale] = COPY[locale].events[event].subject;
      body_html[locale] = htmlFor(event, brand, locale);
      body_text[locale] = textFor(event, brand, locale);
    }
    return { event, subject, body_html, body_text };
  });
}

// ── Sample data for previews ───────────────────────────────────────────────

function sampleVars(locale: Locale): Record<string, string> {
  const sv = locale === 'sv';
  const row = (title: string, variant: string, qty: number, price: string) =>
    `<tr>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;"><img src="https://placehold.co/96x96/f5f5f4/737373.png?text=NC" alt="" width="48" height="48" style="border-radius:6px;border:1px solid #e4e4e7;object-fit:cover;" /></td>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;font-size:13px;color:#18181b;"><div style="font-weight:600;">${title}</div><div style="color:#71717a;font-size:11px;margin-top:2px;">${variant}</div><div style="color:#71717a;font-size:11px;margin-top:2px;">${sv ? 'Antal' : 'Qty'}: ${qty}</div></td>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;text-align:end;font-size:13px;color:#18181b;font-weight:600;white-space:nowrap;">${price}</td>
</tr>`;
  return {
    store_name: 'Natural Cotton',
    store_url: 'https://naturalcotton.se',
    store_logo_url: '',
    customer_name: 'Anna Lindqvist',
    customer_first_name: 'Anna',
    customer_email: 'anna@example.com',
    order_number: 'ORD-SAMPLE-0001',
    order_date: sv ? '28 september 2026' : 'September 28, 2026',
    order_url: 'https://naturalcotton.se/account/orders/sample',
    payment_method: 'Kustom',
    payment_line: sv
      ? 'Din betalning har mottagits.'
      : 'Your payment was received.',
    total: 'SEK 847.00',
    tracking_number: 'SE123456789',
    tracking_url: 'https://example.com/track/SE123456789',
    reason: sv ? 'Varan är slut i lager' : 'Item out of stock',
    refund_amount: 'SEK 847.00',
    items_html: `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;"><tbody>${row(
      sv ? 'T-shirt i ekologisk bomull' : 'Organic cotton T-shirt',
      sv ? 'Färg: Vit / Storlek: M' : 'Color: White / Size: M',
      2,
      'SEK 598.00',
    )}${row(
      sv ? 'Strumpor 3-pack' : 'Socks 3-pack',
      sv ? 'Storlek: 39-42' : 'Size: 39-42',
      1,
      'SEK 200.00',
    )}</tbody></table>`,
    items_text: '- T-shirt × 2 — SEK 598.00\n- Socks × 1 — SEK 200.00',
    totals_html: `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:4px 0 0;"><tbody>
<tr><td style="padding:4px 0;font-size:13px;color:#52525b;">${sv ? 'Delsumma' : 'Subtotal'}</td><td style="padding:4px 0;font-size:13px;color:#52525b;text-align:end;">SEK 798.00</td></tr>
<tr><td style="padding:4px 0;font-size:13px;color:#52525b;">${sv ? 'Frakt (Standardfrakt)' : 'Shipping (Standard)'}</td><td style="padding:4px 0;font-size:13px;color:#52525b;text-align:end;">SEK 49.00</td></tr>
<tr><td style="padding:12px 0 4px;border-top:1px solid #e4e4e7;font-size:16px;font-weight:700;color:#18181b;">${sv ? 'Totalt' : 'Total'}</td><td style="padding:12px 0 4px;border-top:1px solid #e4e4e7;font-size:16px;font-weight:700;color:#18181b;text-align:end;">SEK 847.00</td></tr>
<tr><td colspan="2" style="font-size:12px;color:#71717a;text-align:end;">${sv ? 'Inkl. Moms (25 %): SEK 169.40' : 'Incl. VAT (25 %): SEK 169.40'}</td></tr>
</tbody></table>`,
    totals_text: 'Total: SEK 847.00',
    shipping_address_html:
      'Anna Lindqvist<br />Storgatan 12<br />111 23 Stockholm<br />Sverige',
    shipping_address_text: 'Anna Lindqvist\nStorgatan 12\n111 23 Stockholm',
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DEFAULT_COLORS = {
  text: '#171717',
  muted: '#737373',
  accent: '#f97316',
  border: '#e7e5e4',
  primary: '#111111',
  primaryContrast: '#ffffff',
  surface: '#f5f5f4',
  background: '#ffffff',
};

const HEX = /^#[0-9a-fA-F]{3,8}$/;

async function main(): Promise<void> {
  const slug = arg('slug');
  const dryRun = process.argv.includes('--dry-run');
  const previewDir = arg('preview');
  if (!slug && !dryRun) throw new Error('Pass --slug <store slug>');

  let storeId: string | null = null;
  let storeName = arg('display-name') || slug || 'Store';
  let colors = { ...DEFAULT_COLORS };

  const prisma = dryRun ? null : new PrismaClient();
  try {
    if (prisma && slug) {
      const store = await prisma.store.findUnique({
        where: { slug },
        select: {
          id: true,
          name: true,
          store_type: true,
          theme_customizations: true,
        },
      });
      if (!store) throw new Error(`Store "${slug}" not found`);
      if (store.store_type !== 'INDEPENDENT') {
        throw new Error(
          `Store "${slug}" is ${store.store_type}; only independent stores use their own templates`,
        );
      }
      storeId = store.id;
      storeName = arg('display-name') || store.name;
      const theme = (store.theme_customizations || {}) as {
        colors?: Record<string, unknown>;
      };
      for (const key of Object.keys(colors) as Array<keyof typeof colors>) {
        const value = theme.colors?.[key];
        if (typeof value === 'string' && HEX.test(value)) colors[key] = value;
      }
    }

    const brand: Brand = {
      name: storeName,
      company: arg('company') || '',
      ...colors,
    };
    const templates = buildTemplates(brand);

    if (previewDir) {
      await fs.mkdir(previewDir, { recursive: true });
      for (const t of templates) {
        for (const locale of LOCALES) {
          const vars = sampleVars(locale);
          await fs.writeFile(
            join(previewDir, `${t.event}.${locale}.html`),
            substitute(t.body_html[locale], vars),
            'utf8',
          );
          await fs.writeFile(
            join(previewDir, `${t.event}.${locale}.txt`),
            `${substitute(t.subject[locale], vars)}\n\n${substitute(t.body_text[locale], vars)}`,
            'utf8',
          );
        }
      }
      console.log(`Previews written to ${previewDir}`);
    }

    if (!prisma || !storeId) {
      console.log(`Dry run: built ${templates.length} templates.`);
      return;
    }

    const existing = await prisma.storeNotificationTemplate.findMany({
      where: { store_id: storeId },
    });
    if (existing.length > 0) {
      const backupDir = process.env.BACKUP_DIR || process.cwd();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(backupDir, `email-templates-${slug}-${stamp}.json`);
      await fs.writeFile(file, JSON.stringify(existing, null, 2), 'utf8');
      console.log(`Backed up ${existing.length} existing row(s) to ${file}`);
    }

    for (const t of templates) {
      await prisma.storeNotificationTemplate.upsert({
        where: { store_id_event: { store_id: storeId, event: t.event } },
        create: {
          store_id: storeId,
          event: t.event,
          subject: t.subject,
          body_html: t.body_html,
          body_text: t.body_text,
          enabled: true,
        },
        update: {
          subject: t.subject,
          body_html: t.body_html,
          body_text: t.body_text,
          enabled: true,
        },
      });
      console.log(`  • ${t.event} (${LOCALES.join(', ')})`);
    }
    console.log(`Done. Installed ${templates.length} templates for ${slug}.`);
  } finally {
    await prisma?.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
