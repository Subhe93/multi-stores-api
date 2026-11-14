import { CONSENT_CSV_COLUMNS, csvCell, csvHeader, csvLine } from './csv';

describe('consent-log CSV', () => {
  it.each([
    ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['+1', "'+1"],
    ['-2', "'-2"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tx', "'\tx"],
  ])('neutralizes formula cell %p', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('quotes separators and keeps plain cells', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('accept_all')).toBe('accept_all');
    expect(csvCell(null)).toBe('');
  });

  it('header and line have the same columns', () => {
    expect(csvHeader()).toBe(CONSENT_CSV_COLUMNS.join(',') + '\r\n');
    const line = csvLine({
      id: 'r1',
      created_at: new Date('2026-11-14T10:00:00.000Z'),
      consent_id: '5f0c1d9e-0000-4000-8000-000000000001',
      action: 'save',
      source: 'dialog',
      analytics: true,
      marketing: false,
      external_media: null,
      consent_version: '3',
      vendors: ['clarity', 'ga4'],
      locale: 'sv',
      text_hash: 'legacy',
    });
    expect(line).toBe(
      'r1,2026-11-14T10:00:00.000Z,5f0c1d9e-0000-4000-8000-000000000001,save,dialog,1,0,,3,clarity ga4,sv,legacy\r\n',
    );
    expect(line.trimEnd().split(',')).toHaveLength(CONSENT_CSV_COLUMNS.length);
  });
});
