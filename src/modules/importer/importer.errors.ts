import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';

/** API error codes of the importer (M4.4 §10). */
export const IMPORT_ERROR_CODES = [
  'IMPORT_SOURCE_NOT_FOUND',
  'IMPORT_SOURCE_HOST_INVALID',
  'IMPORT_SOURCE_CREDENTIALS_INVALID',
  'IMPORT_SOURCE_IN_USE',
  'IMPORT_SOURCE_DUPLICATE',
  'IMPORT_SOURCE_KIND_UNSUPPORTED',
  'IMPORT_SOURCE_SETTINGS_INVALID',
  'IMPORT_BUNDLE_TOO_LARGE',
  'IMPORT_BUNDLE_INVALID_ARCHIVE',
  'IMPORT_BUNDLE_UNEXPECTED_FILE',
  'IMPORT_BUNDLE_MISSING_FILE',
  'IMPORT_BUNDLE_BOMB',
  'IMPORT_BUNDLE_PARSE_FAILED',
  'IMPORT_RUN_NOT_FOUND',
  'IMPORT_RUN_BUSY',
  'IMPORT_RUN_INVALID_STATE',
  'IMPORT_RUN_OPTIONS_INVALID',
  'IMPORT_PLAN_STALE',
  'IMPORT_PLATFORM_CATEGORY_REQUIRED',
  'IMPORT_CURRENCY_MISMATCH',
  'IMPORT_RUN_TIMEOUT',
  'IMPORT_RUN_INTERRUPTED',
  'IMPORT_MEDIA_HOST_NOT_ALLOWED',
  'IMPORT_MEDIA_PRIVATE_ADDRESS',
  'IMPORT_MEDIA_TOO_LARGE',
  'IMPORT_MEDIA_TYPE',
  'IMPORT_MEDIA_FETCH_FAILED',
  'IMPORT_MEDIA_QUOTA',
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export function isImportErrorCode(code: unknown): code is ImportErrorCode {
  return (
    typeof code === 'string' &&
    (IMPORT_ERROR_CODES as readonly string[]).includes(code)
  );
}

/**
 * The HTTP error for an engine-side `ImportRunError` (M5 B18: replaces the
 * `e.code as never` cast). Codes the API does not list (adapter / bundle
 * codes) become a 400 with the code kept.
 */
export function importErrorFromRun(err: ImportRunError): HttpException {
  if (isImportErrorCode(err.code)) return importError(err.code, err.message);
  return new BadRequestException({ code: err.code, message: err.message });
}

type ExceptionCtor = new (body: Record<string, unknown>) => HttpException;

const STATUS: Partial<Record<ImportErrorCode, ExceptionCtor>> = {
  IMPORT_SOURCE_NOT_FOUND: NotFoundException,
  IMPORT_RUN_NOT_FOUND: NotFoundException,
  IMPORT_SOURCE_IN_USE: ConflictException,
  IMPORT_SOURCE_DUPLICATE: ConflictException,
  IMPORT_RUN_BUSY: ConflictException,
  IMPORT_RUN_INVALID_STATE: ConflictException,
  IMPORT_PLAN_STALE: ConflictException,
  IMPORT_BUNDLE_TOO_LARGE: PayloadTooLargeException,
  IMPORT_MEDIA_HOST_NOT_ALLOWED: ForbiddenException,
  IMPORT_MEDIA_PRIVATE_ADDRESS: ForbiddenException,
};

/** HTTP exception carrying `{code, message, ...extra}` (the global filter forwards extra keys). */
export function importError(
  code: ImportErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const Ctor = STATUS[code] ?? BadRequestException;
  return new Ctor({ code, message, ...extra });
}

/** Error raised inside the worker/engine; becomes `ImportRun.error` (`CODE: message`). */
export class ImportRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportRunError';
  }
}

/** `CODE: message`, at most 2 KB (ImportRun.error). */
export function formatRunError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'IMPORT_RUN_FAILED';
  const message = err instanceof Error ? err.message : String(err);
  return `${code}: ${message}`.slice(0, 2048);
}

/** True for a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
