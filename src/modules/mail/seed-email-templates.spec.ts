import {
  buildTemplates,
  sampleVars,
} from '../../../prisma/scripts/seed-store-email-templates';
import {
  htmlVars,
  substitute,
} from '../notification-templates/notification-templates.service';

// Seeded store templates with the invoices placeholders (§3.5, watch list
// 5 and 7): without the app the variables are empty strings (or missing) and
// every body renders byte-identically to the template with the invoice
// blocks taken out; with an issued invoice the line and the seller block
// appear.

const brand = {
  name: 'Natural Cotton',
  text: '#171717',
  muted: '#737373',
  accent: '#f97316',
  border: '#e7e5e4',
  primary: '#111111',
  primaryContrast: '#ffffff',
  surface: '#f5f5f4',
  background: '#ffffff',
};

const INVOICE_BLOCK =
  /\{\{#if (invoice_number|seller_block_html|seller_block_text)\}\}[\s\S]*?\{\{\/if\}\}/g;

const emptyInvoiceVars = {
  invoice_number: '',
  credit_note_number: '',
  invoice_url: '',
  seller_block_html: '',
  seller_block_text: '',
  seller_legal_line: '',
};

describe('seeded store email templates with invoice placeholders', () => {
  const templates = buildTemplates(brand);

  it.each(['sv', 'en'] as const)(
    'without the app every body renders as if the blocks were not there (%s)',
    (locale) => {
      const missing = sampleVars(locale);
      const empty = { ...missing, ...emptyInvoiceVars };
      for (const t of templates) {
        for (const [body, vars] of [
          [t.body_html[locale], htmlVars(missing)],
          [t.body_text[locale], missing],
        ] as const) {
          const stripped = substitute(body.replace(INVOICE_BLOCK, ''), vars);
          expect(substitute(body, vars)).toBe(stripped);
          expect(substitute(body, { ...vars, ...emptyInvoiceVars })).toBe(
            stripped,
          );
        }
        expect(substitute(t.body_html[locale], htmlVars(empty))).not.toMatch(
          /#invoices|Faktura|View the invoice/,
        );
      }
    },
  );

  it('with an issued invoice the confirmation and delivered bodies show it', () => {
    const vars = htmlVars({
      ...sampleVars('sv'),
      invoice_number: 'INV-1001',
      'html:invoice_number': 'INV-1001',
      invoice_url: 'https://naturalcotton.se/account/orders/o1#invoices',
      seller_block_html: 'Natural Cotton AB<br />Org.nr 556036-0793',
      seller_block_text: 'Natural Cotton AB\nOrg.nr 556036-0793',
    });
    const byEvent = Object.fromEntries(templates.map((t) => [t.event, t]));
    for (const event of ['order_confirmation', 'order_delivered']) {
      const html = substitute(byEvent[event].body_html.sv, vars);
      expect(html).toContain('Faktura INV-1001');
      expect(html).toContain(
        'href="https://naturalcotton.se/account/orders/o1#invoices"',
      );
      expect(html).toContain('Natural Cotton AB<br />Org.nr 556036-0793');
      const text = substitute(byEvent[event].body_text.sv, vars);
      expect(text).toContain(
        'Faktura INV-1001: https://naturalcotton.se/account/orders/o1#invoices',
      );
    }
    // Other events only carry the seller footer.
    const shipped = substitute(byEvent.order_shipped.body_html.sv, vars);
    expect(shipped).not.toContain('Faktura INV-1001');
    expect(shipped).toContain('Org.nr 556036-0793');
  });
});

// Store without customer accounts: the invoice exists but invoice_url is an
// empty string, so the number shows without a (dead) link.
describe('seeded store email templates with an invoice and no invoice_url', () => {
  const templates = buildTemplates(brand);
  const byEvent = Object.fromEntries(templates.map((t) => [t.event, t]));
  const withInvoice = {
    ...sampleVars('sv'),
    invoice_number: 'INV-1001',
    'html:invoice_number': 'INV-1001',
  };

  it('shows the invoice number alone, without an empty link', () => {
    const vars = htmlVars({ ...withInvoice, invoice_url: '' });
    for (const event of ['order_confirmation', 'order_delivered']) {
      const html = substitute(byEvent[event].body_html.sv, vars);
      expect(html).toContain('Faktura INV-1001</p>');
      expect(html).not.toContain('href=""');
      expect(html).not.toContain('#invoices');
      const text = substitute(byEvent[event].body_text.sv, vars);
      expect(text).toContain('\nFaktura INV-1001\n');
      expect(text).not.toContain('Faktura INV-1001:');
    }
  });

  it('with the address the line is the former one', () => {
    const url = 'https://naturalcotton.se/account/orders/o1#invoices';
    const vars = htmlVars({ ...withInvoice, invoice_url: url });
    const html = substitute(byEvent.order_confirmation.body_html.sv, vars);
    expect(html).toMatch(
      new RegExp(
        `Faktura INV-1001 – <a href="${url}" style="[^"]*">[^<]+</a></p>`,
      ),
    );
    const text = substitute(byEvent.order_confirmation.body_text.sv, vars);
    expect(text).toContain(`\nFaktura INV-1001: ${url}\n`);
  });
});

// Orders that required no shipping: the seeded set has an `order_fulfilled`
// template (the delivered body with neutral wording), and the address block
// prints a "Billing address" section from billing_address_* while the
// delivery section disappears with its empty variable.
describe('seeded store email templates for orders without shipping', () => {
  const templates = buildTemplates(brand);
  const byEvent = Object.fromEntries(templates.map((t) => [t.event, t]));

  it('order_fulfilled exists in both locales with its own copy', () => {
    const t = byEvent.order_fulfilled;
    expect(t).toBeDefined();
    expect(t.subject.en).toBe('Your order {{order_number}} is complete');
    expect(t.subject.sv).toBe('Din beställning {{order_number}} är klar');
    const html = substitute(t.body_html.en, htmlVars(sampleVars('en')));
    expect(html).toContain('Your order is complete');
    expect(html).not.toMatch(/delivered/i);
    const text = substitute(t.body_text.sv, sampleVars('sv'));
    expect(text).toContain('Din beställning är klar');
    expect(text).not.toMatch(/levererats/);
  });

  it('order_fulfilled attaches the invoice line like order_delivered', () => {
    const vars = htmlVars({
      ...sampleVars('sv'),
      invoice_number: 'INV-1001',
      'html:invoice_number': 'INV-1001',
      invoice_url: 'https://naturalcotton.se/account/orders/o1#invoices',
    });
    expect(substitute(byEvent.order_fulfilled.body_html.sv, vars)).toContain(
      'Faktura INV-1001',
    );
  });

  it('order_delivered keeps its own copy', () => {
    expect(byEvent.order_delivered.subject.en).toBe(
      'Your order {{order_number}} has been delivered',
    );
  });

  const noShipping = (locale: 'sv' | 'en') => ({
    ...sampleVars(locale),
    shipping_address_html: '',
    shipping_address_text: '',
    billing_address_html: 'Anna Lindqvist<br />Storgatan 12',
    billing_address_text: 'Anna Lindqvist\nStorgatan 12',
  });

  it('confirmation of an order without shipping: billing section only', () => {
    const html = substitute(
      byEvent.order_confirmation.body_html.en,
      htmlVars(noShipping('en')),
    );
    expect(html).toContain('Billing address');
    expect(html).toContain('Anna Lindqvist<br />Storgatan 12');
    expect(html).not.toContain('Delivery address');
    const text = substitute(
      byEvent.order_confirmation.body_text.sv,
      noShipping('sv'),
    );
    expect(text).toContain('Faktureringsadress:\nAnna Lindqvist\nStorgatan 12');
    expect(text).not.toContain('Leveransadress');
  });

  it('confirmation of a shipping order: delivery section only (billing variable empty or missing)', () => {
    for (const vars of [
      sampleVars('en'),
      {
        ...sampleVars('en'),
        billing_address_html: '',
        billing_address_text: '',
      },
    ]) {
      const html = substitute(
        byEvent.order_confirmation.body_html.en,
        htmlVars(vars),
      );
      expect(html).toContain('Delivery address');
      expect(html).not.toContain('Billing address');
      const text = substitute(byEvent.order_confirmation.body_text.en, vars);
      expect(text).toContain('Delivery address:');
      expect(text).not.toContain('Billing address');
    }
  });
});
