import {
  DEFAULT_INVOICE_SETTINGS,
  parseInvoiceSettings,
  validateInvoiceSettings,
} from './invoice-settings';
import { validateStoreAppSettings } from '../../common/store-apps/settings-validators';

describe('invoice settings', () => {
  it('parse is lenient: defaults merged, bad fields replaced', () => {
    expect(parseInvoiceSettings(null)).toEqual(DEFAULT_INVOICE_SETTINGS);
    expect(
      parseInvoiceSettings({
        auto_issue: false,
        cod_issue_on: 'whenever',
        credit_on_cancel: 'yes',
      }),
    ).toEqual({ ...DEFAULT_INVOICE_SETTINGS, auto_issue: false });
  });

  it('validate is strict: unknown keys, wrong types and bad enum refused', () => {
    expect(validateInvoiceSettings({}).ok).toBe(true);
    expect(validateInvoiceSettings({ cod_issue_on: 'created' }).ok).toBe(true);
    const res = validateInvoiceSettings({
      auto_issue: 'true',
      cod_issue_on: 'shipped',
      foo: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(3);
    expect(validateInvoiceSettings([]).ok).toBe(false);
  });

  it('is registered in the store-apps validator seam; other apps unaffected', () => {
    expect(validateStoreAppSettings('invoices', { foo: 1 })).toHaveLength(1);
    expect(validateStoreAppSettings('markets', { foo: 1 })).toEqual([]);
  });
});
