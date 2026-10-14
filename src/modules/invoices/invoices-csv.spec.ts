import { csvAmount, csvText, invoicesToCsv } from './invoices-csv';
import type { InvoiceSnapshot } from './invoices.types';

describe('invoices CSV', () => {
  it('escapes formulas in text cells only and quotes separators', () => {
    expect(csvText('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvText('-x')).toBe("'-x");
    expect(csvText('@me')).toBe("'@me");
    expect(csvText('Acme, "Inc"')).toBe('"Acme, ""Inc"""');
    expect(csvText(null)).toBe('');
  });

  it('keeps negative amounts numeric with the currency decimals', () => {
    expect(csvAmount(-120, 'SEK')).toBe('-120.00');
    expect(csvAmount(-0, 'SEK')).toBe('0.00');
    expect(csvAmount(1500, 'JPY')).toBe('1500');
  });

  it('renders header, rows and the VAT breakdown', () => {
    const snapshot = {
      buyer: { org_number: '556036-0793', vat_number: 'SE556036079301' },
      payment: { method: 'STRIPE' },
      vat_summary: [
        { rate_bp: 2500, vat: -20 },
        { rate_bp: 1200, vat: -1.2 },
      ],
    } as unknown as InvoiceSnapshot;
    const csv = invoicesToCsv([
      {
        number: 'CN-1',
        kind: 'CREDIT_NOTE',
        issue_date: '2026-10-14',
        due_date: null,
        credited_number: '1001',
        order_number: 'ORD-1',
        buyer_type: 'COMPANY',
        buyer_name: '=HYPERLINK("x")',
        currency: 'SEK',
        paid: true,
        net_total: -96,
        vat_total: -21.2,
        gross_total: -117.2,
        snapshot,
      },
    ]);
    const [header, row] = csv.split('\r\n');
    expect(header.split(',')).toHaveLength(17);
    expect(row).toBe(
      'CN-1,CREDIT_NOTE,2026-10-14,,1001,ORD-1,COMPANY,"\'=HYPERLINK(""x"")",556036-0793,SE556036079301,STRIPE,true,SEK,-96.00,-21.20,-117.20,"25%:-20.00;12%:-1.20"',
    );
  });
});
