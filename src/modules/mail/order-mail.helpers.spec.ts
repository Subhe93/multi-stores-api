import {
  formatMoney,
  renderCompanyBlock,
  renderOrderTotals,
} from './order-mail.helpers';

const sek = (n: number) => formatMoney(n, 'SEK');

// b2b app in order emails: the company block and the net-first totals
// layout. The default layout (no buyerMode) must stay exactly what every
// person order received before the app (watch list 12).

describe('renderCompanyBlock', () => {
  it('is empty for a person order (and for a company order without data)', () => {
    expect(renderCompanyBlock({ customer_type: null }, 'en')).toEqual({
      html: '',
      text: '',
    });
    expect(
      renderCompanyBlock({ customer_type: 'PERSON', company_name: 'X' }, 'en'),
    ).toEqual({ html: '', text: '' });
    expect(renderCompanyBlock({ customer_type: 'COMPANY' }, 'en')).toEqual({
      html: '',
      text: '',
    });
  });

  it('prints name, org number, VAT and reference in the locale, escaped', () => {
    const order = {
      customer_type: 'COMPANY',
      company_name: 'Neronet <Academy> AB',
      org_number: '556036-0793',
      vat_number: 'SE556677889901',
      buyer_reference: 'Anna',
    };
    expect(renderCompanyBlock(order, 'sv')).toEqual({
      html: 'Neronet &lt;Academy&gt; AB<br />Organisationsnummer: 556036-0793<br />Momsregistreringsnummer: SE556677889901<br />Referens: Anna',
      text: 'Neronet <Academy> AB\nOrganisationsnummer: 556036-0793\nMomsregistreringsnummer: SE556677889901\nReferens: Anna',
    });
    expect(
      renderCompanyBlock({ ...order, vat_number: null, buyer_reference: ' ' })
        .text,
    ).toBe('Neronet <Academy> AB\nOrganisation number: 556036-0793');
  });

  // b2b app M2.5: reverse-charge note, only when the order carries it.
  it('appends the reverse-charge note with the validated number', () => {
    const order = {
      customer_type: 'COMPANY',
      company_name: 'Muster GmbH',
      org_number: 'HRB 1',
      vat_number: null,
      tax_exempt_reason: 'REVERSE_CHARGE',
      vat_validation: { vat_number: 'DE123456789' },
    };
    expect(renderCompanyBlock(order, 'en').text).toBe(
      'Muster GmbH\nOrganisation number: HRB 1\nReverse charge: VAT to be accounted for by the recipient (VAT no. DE123456789)',
    );
    expect(renderCompanyBlock(order, 'sv').text).toContain(
      'Omvänd skattskyldighet',
    );
    expect(
      renderCompanyBlock({ ...order, tax_exempt_reason: null }, 'en').text,
    ).toBe('Muster GmbH\nOrganisation number: HRB 1');
  });
});

describe('renderOrderTotals', () => {
  const input = {
    subtotal: 598,
    discount: 0,
    shipping: 49,
    shippingMethod: 'Standard',
    total: 647,
    taxLines: ['Inkl. Moms (25 %): SEK 129.40'],
  };

  it('default layout: total row, then muted tax lines under it', () => {
    const { totals_html, totals_text } = renderOrderTotals(input, 'SEK', 'sv');
    expect(totals_text).toBe(
      [
        `Delsumma: ${sek(598)}`,
        `Frakt (Standard): ${sek(49)}`,
        `Totalt: ${sek(647)}`,
        'Inkl. Moms (25 %): SEK 129.40',
      ].join('\n'),
    );
    expect(totals_html).not.toContain('Nettosumma');
    expect(totals_html.indexOf('Totalt')).toBeLessThan(
      totals_html.indexOf('Inkl. Moms'),
    );
    // Explicit 'incl' is the same as the default.
    expect(
      renderOrderTotals({ ...input, buyerMode: 'incl' }, 'SEK', 'sv'),
    ).toEqual(renderOrderTotals(input, 'SEK', 'sv'));
  });

  it('excl layout: net total row, VAT rows as regular rows, "Total incl. VAT"', () => {
    const { totals_html, totals_text } = renderOrderTotals(
      { ...input, buyerMode: 'excl', netTotal: 517.6 },
      'SEK',
      'sv',
    );
    expect(totals_text).toBe(
      [
        `Delsumma: ${sek(598)}`,
        `Frakt (Standard): ${sek(49)}`,
        `Nettosumma: ${sek(517.6)}`,
        'Inkl. Moms (25 %): SEK 129.40',
        `Totalt inkl. moms: ${sek(647)}`,
      ].join('\n'),
    );
    expect(totals_html).toContain('Nettosumma');
    expect(totals_html).toContain('Totalt inkl. moms');
    expect(totals_html.indexOf('Inkl. Moms')).toBeLessThan(
      totals_html.indexOf('Totalt inkl. moms'),
    );
    // The VAT row is a regular row, not the muted small print.
    expect(totals_html).not.toContain('color:#71717a');
  });
});
