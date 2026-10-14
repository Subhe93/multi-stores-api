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
