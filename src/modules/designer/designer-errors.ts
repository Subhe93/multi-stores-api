import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';

/**
 * Error codes of the designer app (M4.2 §4.4). Every error body is
 * `{code, message, params?}`; the dashboard and the storefront translate
 * `errors.<code>`. WP3 adds the asset/font/link codes at the end.
 */
export const DESIGNER_ERROR_CODES = [
  'DESIGNER_NOT_ENABLED',
  'DESIGNER_DESIGN_REQUIRED',
  'DESIGNER_DESIGN_NOT_FOUND',
  'DESIGNER_DESIGN_FORBIDDEN',
  'DESIGNER_DESIGN_LOCKED',
  'DESIGNER_DESIGN_STALE',
  'DESIGNER_TEMPLATE_MISMATCH',
  'DESIGNER_STATE_INVALID',
  'DESIGNER_UPLOAD_TYPE',
  'DESIGNER_UPLOAD_TOO_LARGE',
  'DESIGNER_UPLOAD_DIMENSIONS',
  'DESIGNER_UPLOAD_CORRUPT',
  'DESIGNER_RENDER_UNAVAILABLE',
  'DESIGNER_PRINT_NOT_READY',
  'DESIGNER_FILES_PURGED',
  'DESIGNER_TEMPLATE_IN_USE',
  'DESIGNER_TEMPLATE_INVALID',
  'DESIGNER_IMPORT_INVALID',
  'DESIGNER_IMPORT_FETCH_FAILED',
  'DESIGNER_ADDONS_NOT_SUPPORTED',
  // WP3 (storage, assets, fonts, signed links).
  'DESIGNER_TEMPLATE_NOT_FOUND',
  'DESIGNER_ASSET_NOT_FOUND',
  'DESIGNER_ASSET_IN_USE',
  'DESIGNER_ASSET_KIND',
  'DESIGNER_FONT_INVALID',
  'DESIGNER_FILE_NOT_FOUND',
  'DESIGNER_LINK_EXPIRED',
  // M4.2 fixes (lifecycle): template still linked to enabled products;
  // print regenerate on a cancelled / refunded / failed order.
  'DESIGNER_TEMPLATE_LINKED',
  'DESIGNER_ORDER_TERMINAL',
  // M4.2 fixes (uploads): quota (429), disk low / pipeline saturated (503).
  'DESIGNER_UPLOAD_QUOTA',
  'DESIGNER_STORAGE_FULL',
  'DESIGNER_UPLOAD_BUSY',
  // M5.5 add-ons: invalid add-on config (creator) or selection (customer).
  'DESIGNER_ADDONS_INVALID',
  // M5.6: the back side (shape, template not offered / not published).
  'DESIGNER_BACK_INVALID',
] as const;

export type DesignerErrorCode = (typeof DESIGNER_ERROR_CODES)[number];

type Params = Record<string, unknown>;

function body(code: DesignerErrorCode, message: string, params?: Params) {
  return params ? { code, message, params } : { code, message };
}

export const designerErrors = {
  badRequest: (code: DesignerErrorCode, message: string, params?: Params) =>
    new BadRequestException(body(code, message, params)),
  notFound: (code: DesignerErrorCode, message: string, params?: Params) =>
    new NotFoundException(body(code, message, params)),
  conflict: (code: DesignerErrorCode, message: string, params?: Params) =>
    new ConflictException(body(code, message, params)),
  forbidden: (code: DesignerErrorCode, message: string, params?: Params) =>
    new ForbiddenException(body(code, message, params)),
  gone: (code: DesignerErrorCode, message: string, params?: Params) =>
    new GoneException(body(code, message, params)),
  tooLarge: (message: string, params?: Params) =>
    new PayloadTooLargeException(
      body('DESIGNER_UPLOAD_TOO_LARGE', message, params),
    ),
};

/** The `code` of a Nest HttpException body, if any (tests and callers). */
export function designerErrorCode(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const res = e.getResponse();
  return typeof res === 'object' && res !== null && 'code' in res
    ? String((res as { code: unknown }).code)
    : undefined;
}
