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
function esc(s: string): string {
  return String(s)
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
    <div style="max-width:480px;margin:0 auto;padding:24px;">
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

export interface OrderConfirmationData {
  orderNumber: string;
  total: string; // already formatted, e.g. "SEK 423.30"
  paid: boolean; // true = paid (card), false = cash on delivery
  orderUrl?: string;
}

export function orderConfirmationEmail(data: OrderConfirmationData): EmailParts {
  const paymentLine = data.paid
    ? 'Your payment was received.'
    : 'You chose cash on delivery — please pay the courier on arrival.';
  const cta = data.orderUrl
    ? `<p style="margin:20px 0;">${button('View your order', data.orderUrl)}</p>`
    : '';
  return {
    subject: `Order ${data.orderNumber} confirmed`,
    html: layout(
      'Thanks for your order!',
      `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">
         Your order <strong>${esc(data.orderNumber)}</strong> has been placed. ${paymentLine}
       </p>
       <p style="font-size:14px;color:#3f3f46;">Total: <strong>${esc(data.total)}</strong></p>
       ${cta}`,
    ),
    text: `Thanks for your order!\n\nOrder ${data.orderNumber} has been placed. ${paymentLine}\nTotal: ${data.total}${
      data.orderUrl ? `\n\nView your order: ${data.orderUrl}` : ''
    }`,
  };
}
