import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Error codes of the personalization app (M4.1 §4.3, C34). The body is
 * `{code, message, errors?, params?}`; the global exception filter forwards
 * the extra keys (M4-INTEGRATION §0).
 */
export const PERSONALIZATION_INVALID = 'PERSONALIZATION_INVALID';
export const PERSONALIZATION_APP_REQUIRED = 'PERSONALIZATION_APP_REQUIRED';
export const PERSONALIZATION_CREATOR_PRODUCT_ONLY =
  'PERSONALIZATION_CREATOR_PRODUCT_ONLY';
export const PERSONALIZATION_CONFIG_INVALID = 'PERSONALIZATION_CONFIG_INVALID';
export const PERSONALIZATION_PRESET_UNKNOWN = 'PERSONALIZATION_PRESET_UNKNOWN';
export const PERSONALIZATION_PRESET_PARAMS_INVALID =
  'PERSONALIZATION_PRESET_PARAMS_INVALID';
export const PERSONALIZATION_PRESET_CONFLICT =
  'PERSONALIZATION_PRESET_CONFLICT';
export const PERSONALIZATION_TEMPLATE_NOT_FOUND =
  'PERSONALIZATION_TEMPLATE_NOT_FOUND';
export const PERSONALIZATION_TEMPLATE_LIMIT = 'PERSONALIZATION_TEMPLATE_LIMIT';
export const PERSONALIZATION_OPTION_IN_USE = 'PERSONALIZATION_OPTION_IN_USE';
export const PERSONALIZATION_FIELD_IN_USE = 'PERSONALIZATION_FIELD_IN_USE';
export const PERSONALIZATION_PRICE_TOO_HIGH = 'PERSONALIZATION_PRICE_TOO_HIGH';
export const PERSONALIZATION_FIELD_LIMIT = 'PERSONALIZATION_FIELD_LIMIT';
export const PERSONALIZATION_UNAVAILABLE = 'PERSONALIZATION_UNAVAILABLE';
export const PERSONALIZATION_VARIANT_REQUIRED =
  'PERSONALIZATION_VARIANT_REQUIRED';

/** Field-count caps of the field write paths (custom fields, presets, library). */
export const FIELD_LIMITS = {
  perProduct: 100,
  perRepeater: 20,
} as const;

/**
 * Largest amount a Decimal(10,2) column holds (unit price, line total,
 * per-unit delta): 99 999 999.99.
 */
export const MAX_MONEY_AMOUNT = 99_999_999.99;

/** One problem of a field configuration (`path` is a dotted JSON path). */
export interface ConfigIssue {
  path: string;
  code: string;
  params?: Record<string, string | number>;
}

export function configInvalid(errors: ConfigIssue[]): BadRequestException {
  return new BadRequestException({
    code: PERSONALIZATION_CONFIG_INVALID,
    message: 'The personalization settings of this field are not valid',
    errors,
  });
}

export function appRequired(): ForbiddenException {
  return new ForbiddenException({
    code: PERSONALIZATION_APP_REQUIRED,
    message:
      'This field configuration needs the Personalization app to be enabled for the store',
  });
}

export function creatorProductOnly(): BadRequestException {
  return new BadRequestException({
    code: PERSONALIZATION_CREATOR_PRODUCT_ONLY,
    message:
      "Advanced personalization is only available on the store creator's own products",
  });
}

export function presetUnknown(key: string): NotFoundException {
  return new NotFoundException({
    code: PERSONALIZATION_PRESET_UNKNOWN,
    message: `Unknown personalization preset "${key.slice(0, 60)}"`,
    params: { key: key.slice(0, 60) },
  });
}

export function presetParamsInvalid(
  errors: ConfigIssue[],
): BadRequestException {
  return new BadRequestException({
    code: PERSONALIZATION_PRESET_PARAMS_INVALID,
    message: 'The preset parameters are not valid',
    errors,
  });
}

export function presetConflict(names: string[]): ConflictException {
  return new ConflictException({
    code: PERSONALIZATION_PRESET_CONFLICT,
    message: `The product already has fields named ${names.map((n) => `"${n}"`).join(', ')}`,
    params: { names: names.join(', ') },
  });
}

export function templateNotFound(): NotFoundException {
  return new NotFoundException({
    code: PERSONALIZATION_TEMPLATE_NOT_FOUND,
    message: 'Field template not found',
  });
}

/** 409: a variant option (or option value) is still read by personalization fields. */
export function optionInUse(
  fields: string[],
  options: string[],
): ConflictException {
  return new ConflictException({
    code: PERSONALIZATION_OPTION_IN_USE,
    message: `Option ${options.map((o) => `"${o}"`).join(', ')} is used by the personalization fields ${fields.map((f) => `"${f}"`).join(', ')}`,
    params: { fields, options },
  });
}

/** 409: other fields (or the store's URL prefill) still reference the field. */
export function fieldInUse(fields: string[]): ConflictException {
  return new ConflictException({
    code: PERSONALIZATION_FIELD_IN_USE,
    message: `This field is still referenced by ${fields.map((f) => `"${f}"`).join(', ')}`,
    params: { fields },
  });
}

/** 400: the personalization price does not fit the order amounts. */
export function priceTooHigh(): BadRequestException {
  return new BadRequestException({
    code: PERSONALIZATION_PRICE_TOO_HIGH,
    message: 'The personalization price of this item is too high',
  });
}

/** 400: the product (or repeater) already has the maximum number of fields. */
export function fieldLimit(max: number): BadRequestException {
  return new BadRequestException({
    code: PERSONALIZATION_FIELD_LIMIT,
    message: `At most ${max} fields are allowed here`,
    params: { max },
  });
}

/** 503: the app state could not be read for a product that needs it (fail closed). */
export function personalizationUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: PERSONALIZATION_UNAVAILABLE,
    message:
      'Personalization is temporarily unavailable. Please try again in a moment.',
  });
}

/** 400: a product with variants needs the chosen variant to evaluate its personalization. */
export function variantRequired(): BadRequestException {
  return new BadRequestException({
    code: PERSONALIZATION_VARIANT_REQUIRED,
    message: 'Please choose a product variant',
  });
}
