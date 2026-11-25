// M172: is a product "personalised", i.e. made to the buyer's specification?
// Such goods are exempt from the right of withdrawal, so a store may publish
// them as not returnable (`merchant_policies.personalized_no_returns`,
// stores/merchant-policies.ts). Pure module (no Prisma, no Nest providers).
//
// The rule (conservative: in doubt the product is NOT personalised):
// a product is personalised when the buyer can supply own content for it on
// the product page, which is one of
//   1. a buyer-facing custom field that takes free content: a text
//      (TEXT, TEXTAREA) or an upload (IMAGE, MULTI_IMAGE, FILE), at the top
//      level or as a child of a repeater;
//   2. a live designer (design-your-own) link.
// A required and an optional input both count: once the buyer filled it in,
// the item is produced to their specification, and the structured data is
// per product, not per order line.
//
// What is NOT a signal:
// - `customization_type` (PRINT, ENGRAVE, ...) is a production method;
// - `product_type` CUSTOMIZABLE alone says nothing about buyer input;
// - a marketplace CustomProduct is a creator's design: only the fields the
//   creator left open for the buyer count (the caller passes those);
// - fields that pick among the seller's own choices (SELECT, COLOR, FONT,
//   CHECKBOX_GROUP, COLOR_PALETTE) are closer to a variant than to buyer
//   content, and NUMBER / DATE are too ambiguous (a quantity, a delivery
//   date) to count;
// - a text field with a built-in identity format (`validation_rules.format`,
//   e.g. personnummer) collects data ABOUT the buyer, not content produced
//   on the item, so the right of withdrawal stays.
//
// Known limit: a free text field used for something else than the item
// (a gift or delivery note) cannot be told apart and still counts.

/** Field types whose value is the buyer's own content. */
export const BUYER_CONTENT_FIELD_TYPES: ReadonlySet<string> = new Set([
  'TEXT',
  'TEXTAREA',
  'IMAGE',
  'MULTI_IMAGE',
  'FILE',
]);

/**
 * Built-in `validation_rules.format` values (shared core, rules.ts
 * VALIDATION_FORMATS) that describe the buyer's identity. Listed here by
 * name on purpose: a future format is treated as buyer content until it is
 * reviewed and added.
 */
export const IDENTITY_FIELD_FORMATS: ReadonlySet<string> = new Set([
  'personnummer',
]);

/** A buyer-facing custom field as the product page publishes it. */
export interface BuyerFacingField {
  type: string;
  /** Raw stored JSON; only `format` is read. */
  validation_rules?: unknown;
  /** Repeater children (personalization app payload). */
  children?: readonly BuyerFacingField[] | null;
}

export interface PersonalisedProductInput {
  /**
   * The custom fields the buyer sees on the product page, exactly as the
   * product read publishes them (`shapeFieldsForStorefront`; for a custom
   * product without the fields its creator pre-filled).
   */
  fields?: readonly BuyerFacingField[] | null;
  /** The product page offers the designer (app on, link enabled, published). */
  designer?: boolean | null;
}

/** A text field whose value is identity data (see IDENTITY_FIELD_FORMATS). */
function collectsIdentityData(field: BuyerFacingField): boolean {
  if (field.type !== 'TEXT' && field.type !== 'TEXTAREA') return false;
  const rules = field.validation_rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return false;
  const format = (rules as { format?: unknown }).format;
  return typeof format === 'string' && IDENTITY_FIELD_FORMATS.has(format);
}

function takesBuyerContent(
  field: BuyerFacingField | null | undefined,
): boolean {
  if (!field || typeof field.type !== 'string') return false;
  if (BUYER_CONTENT_FIELD_TYPES.has(field.type)) {
    return !collectsIdentityData(field);
  }
  return (
    Array.isArray(field.children) && field.children.some(takesBuyerContent)
  );
}

/** See the rule at the top of the file. */
export function isBuyerPersonalisedProduct(
  input: PersonalisedProductInput | null | undefined,
): boolean {
  if (!input) return false;
  if (input.designer === true) return true;
  return Array.isArray(input.fields) && input.fields.some(takesBuyerContent);
}
