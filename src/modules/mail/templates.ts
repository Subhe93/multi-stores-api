// Plain, dependency-free HTML email templates. Each builder returns the subject
// plus html and text parts. Kept intentionally simple (inline styles) so they
// render across mail clients without a build step.

interface EmailParts {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'Multi Stores';

// Escape interpolated values as defense-in-depth, so a future user-controlled
// field can't inject markup into the email body or break out of an attribute.
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
    <div style="max-width:520px;margin:0 auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">
        <h1 style="font-size:18px;margin:0 0 16px;">${title}</h1>
        ${bodyHtml}
      </div>
      <p style="font-size:11px;color:#a1a1aa;text-align:center;margin-top:16px;">${BRAND}</p>
    </div>
  </body>
</html>`;
}

function button(label: string, url: string): string {
  return `<a href="${esc(url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">${esc(label)}</a>`;
}

export function passwordResetEmail(resetUrl: string): EmailParts {
  return {
    subject: `Reset your ${BRAND} password`,
    html: layout(
      'Reset your password',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.
       </p>
       <p style="margin:20px 0;">${button('Reset password', resetUrl)}</p>
       <p style="font-size:12px;color:#71717a;">If you didn't request this, you can safely ignore this email.</p>`,
    ),
    text: `Reset your ${BRAND} password.\n\nOpen this link to choose a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.`,
  };
}

// ── Order emails ────────────────────────────────────────────────────────────
// All order email builders accept a pre-rendered itemsHtml/itemsText block so
// the template doesn't need a loop construct. Helpers in order-mail.helpers.ts
// produce those blocks from the loaded order.

export interface OrderConfirmationData {
  orderNumber: string;
  total: string; // already formatted, e.g. "SEK 423.30"
  paid: boolean; // true = paid (card), false = cash on delivery
  orderUrl?: string;
  itemsHtml?: string;
  itemsText?: string;
}

export function orderConfirmationEmail(data: OrderConfirmationData): EmailParts {
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
       <p style="font-size:14px;color:#3f3f46;">Total: <strong>${esc(data.total)}</strong></p>
       ${cta}`,
    ),
    text: `Thanks for your order!\n\nOrder ${data.orderNumber} has been placed. ${paymentLine}${itemsText}\nTotal: ${data.total}${
      data.orderUrl ? `\n\nView your order: ${data.orderUrl}` : ''
    }`,
  };
}

export interface OrderShippedData {
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
    ),
    text:
      `Your order ${data.orderNumber} has shipped.` +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.trackingNumber ? `\n\nTracking: ${data.trackingNumber}` : '') +
      (data.trackingUrl ? `\nTrack: ${data.trackingUrl}` : '') +
      (data.orderUrl ? `\nView order: ${data.orderUrl}` : ''),
  };
}

export interface OrderDeliveredData {
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
    ),
    text:
      `Your order ${data.orderNumber} has been delivered.` +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderUrl ? `\n\nView order: ${data.orderUrl}` : ''),
  };
}

export interface OrderCancelledData {
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
    ),
    text:
      `Order ${data.orderNumber} has been cancelled.` +
      (data.reason ? `\nReason: ${data.reason}` : '') +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderUrl ? `\n\nView order: ${data.orderUrl}` : ''),
  };
}

export interface OrderRefundedData {
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
    ),
    text:
      `A refund has been processed for order ${data.orderNumber}.` +
      (data.refundAmount ? `\nRefunded: ${data.refundAmount}` : '') +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderUrl ? `\n\nView order: ${data.orderUrl}` : ''),
  };
}

export interface NewOrderOwnerData {
  orderNumber: string;
  total: string;
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
       ${customerBit}
       ${data.itemsHtml || ''}
       ${cta}`,
    ),
    text:
      `New order ${data.orderNumber}${data.storeName ? ` for ${data.storeName}` : ''}. Total: ${data.total}.` +
      (data.customerName ? `\nCustomer: ${data.customerName}` : '') +
      (data.itemsText ? `\n\n${data.itemsText}` : '') +
      (data.orderAdminUrl ? `\n\nOpen: ${data.orderAdminUrl}` : ''),
  };
}

export interface WelcomeData {
  name?: string;
  loginUrl?: string;
}

export function welcomeEmail(data: WelcomeData): EmailParts {
  const greeting = data.name ? `Hi ${esc(data.name)},` : 'Hi there,';
  const cta = data.loginUrl
    ? `<p style="margin:20px 0;">${button('Sign in', data.loginUrl)}</p>`
    : '';
  return {
    subject: `Welcome to ${BRAND}`,
    html: layout(
      `Welcome to ${BRAND}`,
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         ${greeting} we're glad you're here. Your account is ready — start exploring stores and products built by independent creators.
       </p>
       ${cta}`,
    ),
    text: `Welcome to ${BRAND}!\n\nYour account is ready.${data.loginUrl ? `\n\nSign in: ${data.loginUrl}` : ''}`,
  };
}
