import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

// `{code, message}` errors of the invoices app (M3 §3.6). Clients translate
// `errors.<code>`; extra keys (missing, invoice_id) travel with the error.

export const invoiceErrors = {
  profileIncomplete: (missing: string[]) =>
    new BadRequestException({
      code: 'INVOICE_PROFILE_INCOMPLETE',
      message: `The seller's legal profile is incomplete: ${missing.join(', ')}.`,
      missing,
    }),
  sequenceLocked: () =>
    new ConflictException({
      code: 'INVOICE_SEQUENCE_LOCKED',
      message:
        'The next number can no longer be changed: documents were already issued in this series.',
    }),
  numberingInvalid: (message: string) =>
    new BadRequestException({ code: 'INVOICE_NUMBERING_INVALID', message }),
  orderNotEligible: (message: string) =>
    new BadRequestException({ code: 'INVOICE_ORDER_NOT_ELIGIBLE', message }),
  snapshotInvalid: (message: string, problems: string[] = []) =>
    new UnprocessableEntityException({
      code: 'INVOICE_SNAPSHOT_INVALID',
      message,
      problems,
    }),
  alreadyIssued: (invoiceId: string, number: string) =>
    new ConflictException({
      code: 'INVOICE_ALREADY_ISSUED',
      message: `Invoice ${number} was already issued for this order.`,
      invoice_id: invoiceId,
    }),
  notFound: () =>
    new NotFoundException({
      code: 'INVOICE_NOT_FOUND',
      message: 'Invoice not found',
    }),
  creditExceeds: (remaining: number) =>
    new BadRequestException({
      code: 'INVOICE_CREDIT_EXCEEDS',
      message: `The amount exceeds what is left to credit (${remaining}).`,
      remaining,
    }),
  creditNothingLeft: () =>
    new BadRequestException({
      code: 'INVOICE_CREDIT_NOTHING_LEFT',
      message: 'This invoice has already been credited in full.',
    }),
  pdfUnavailable: () =>
    new ServiceUnavailableException({
      code: 'INVOICE_PDF_UNAVAILABLE',
      message: 'The PDF cannot be generated right now.',
    }),
  appNotEnabled: () =>
    new ForbiddenException({
      code: 'STORE_APP_NOT_ENABLED',
      message: 'The "invoices" app is not enabled for this store.',
    }),
  ibanInvalid: () =>
    new BadRequestException({
      code: 'INVOICE_IBAN_INVALID',
      message: 'The IBAN is not valid.',
    }),
  bankgiroInvalid: () =>
    new BadRequestException({
      code: 'INVOICE_BANKGIRO_INVALID',
      message: 'The bankgiro number is not valid (NNNN-NNNN).',
    }),
  bicInvalid: () =>
    new BadRequestException({
      code: 'INVOICE_BIC_INVALID',
      message: 'The BIC / SWIFT code is not valid.',
    }),
  vatNumberInvalid: () =>
    new BadRequestException({
      code: 'INVOICE_VAT_NUMBER_INVALID',
      message: 'The VAT number is not valid.',
    }),
  timezoneInvalid: () =>
    new BadRequestException({
      code: 'INVOICE_TIMEZONE_INVALID',
      message: 'Unknown timezone.',
    }),
};

/** The `code` of an error thrown with `{code, message}`, if any. */
export function errorCode(err: unknown): string | null {
  const res = (err as { getResponse?: () => unknown })?.getResponse?.();
  if (res && typeof res === 'object' && 'code' in res) {
    const code = (res as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}
