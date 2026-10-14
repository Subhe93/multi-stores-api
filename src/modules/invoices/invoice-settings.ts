import {
  DEFAULT_INVOICE_SETTINGS,
  type InvoiceCodIssueOn,
  type InvoiceSettings,
} from './invoices.types';

// StoreApp.settings of the invoices app (D9). A lenient parse for the hot
// paths (triggers, mail) and a strict validation for the dashboard write
// (PUT /stores/my/apps/invoices), whose errors become
// STORE_APP_SETTINGS_INVALID through the settings-validator seam.

export { DEFAULT_INVOICE_SETTINGS };

const COD_ISSUE_ON: readonly InvoiceCodIssueOn[] = ['created', 'delivered'];
const BOOLEAN_KEYS = [
  'auto_issue',
  'attach_pdf_to_email',
  'credit_on_cancel',
] as const;
const KNOWN_KEYS: readonly string[] = [...BOOLEAN_KEYS, 'cod_issue_on'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCodIssueOn(value: unknown): value is InvoiceCodIssueOn {
  return (
    typeof value === 'string' && (COD_ISSUE_ON as string[]).includes(value)
  );
}

/** Lenient read: defaults merged, invalid fields replaced by their default. */
export function parseInvoiceSettings(raw: unknown): InvoiceSettings {
  const d = DEFAULT_INVOICE_SETTINGS;
  if (!isRecord(raw)) return { ...d };
  const bool = (key: (typeof BOOLEAN_KEYS)[number]) =>
    typeof raw[key] === 'boolean' ? raw[key] : d[key];
  return {
    auto_issue: bool('auto_issue'),
    cod_issue_on: isCodIssueOn(raw.cod_issue_on)
      ? raw.cod_issue_on
      : d.cod_issue_on,
    attach_pdf_to_email: bool('attach_pdf_to_email'),
    credit_on_cancel: bool('credit_on_cancel'),
  };
}

/**
 * Strict write validation. Every key is optional (the dashboard may send a
 * subset), but unknown keys are refused and a present key must have the
 * right type.
 */
export function validateInvoiceSettings(raw: unknown): {
  ok: boolean;
  errors: string[];
} {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['settings must be an object.'] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) errors.push(`Unknown setting "${key}".`);
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in raw && typeof raw[key] !== 'boolean') {
      errors.push(`${key} must be true or false.`);
    }
  }
  if ('cod_issue_on' in raw && !isCodIssueOn(raw.cod_issue_on)) {
    errors.push(`cod_issue_on must be one of ${COD_ISSUE_ON.join(', ')}.`);
  }
  return { ok: errors.length === 0, errors };
}
