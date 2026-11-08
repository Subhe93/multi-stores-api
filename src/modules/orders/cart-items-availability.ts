import { ConflictException } from '@nestjs/common';

/**
 * Lines whose product / variant / custom product was deleted, archived,
 * unpublished or belongs to another store (FIXES-1 item 5). Quote, order
 * creation, Stripe create-intent and the Kustom session answer
 * `409 CART_ITEMS_UNAVAILABLE` with these, so the storefront can drop the
 * lines instead of failing with a 404 / 500.
 */
export const CART_ITEMS_UNAVAILABLE = 'CART_ITEMS_UNAVAILABLE';

export interface UnavailableCartItem {
  product_id?: string;
  variant_id?: string;
  custom_product_id?: string;
  /** Server cart row id, when the line is a cart row (additive field). */
  line_id?: string;
}

export interface AvailabilityLine {
  id?: string | null;
  product_id?: string | null;
  variant_id?: string | null;
  custom_product_id?: string | null;
}

/**
 * Thrown by the order pricing of ONE line whose catalogue row is gone or not
 * sellable here; the pricing loops collect every such line and answer one
 * CART_ITEMS_UNAVAILABLE. Never reaches a client as is.
 */
export class LineUnavailableError extends Error {
  constructor() {
    super('Cart line is no longer available');
    this.name = 'LineUnavailableError';
  }
}

export function isLineUnavailable(err: unknown): err is LineUnavailableError {
  return err instanceof LineUnavailableError;
}

/** The ids of a line as the `unavailable[]` entry names them. */
export function unavailableEntry(line: AvailabilityLine): UnavailableCartItem {
  return {
    ...(line.product_id ? { product_id: line.product_id } : {}),
    ...(line.variant_id ? { variant_id: line.variant_id } : {}),
    ...(line.custom_product_id
      ? { custom_product_id: line.custom_product_id }
      : {}),
    ...(line.id ? { line_id: line.id } : {}),
  };
}

export function cartItemsUnavailable(
  unavailable: UnavailableCartItem[],
): ConflictException {
  return new ConflictException({
    code: CART_ITEMS_UNAVAILABLE,
    message:
      'An item in your cart is no longer available. Please remove it and try again.',
    unavailable,
  });
}

/**
 * Items of an UNPAID order that can no longer be sold (Stripe create-intent).
 * A deleted product / custom product nulls the item's FKs (ON DELETE SET
 * NULL, variants cascade with their product), so an item with no catalogue
 * id left lost its product; an item whose product
 * or custom product is no longer PUBLISHED, or whose variant was disabled,
 * is unavailable too. Relations that were not loaded (undefined) are not
 * judged.
 */
export function unavailableOrderItems(
  items: readonly {
    product_id?: string | null;
    variant_id?: string | null;
    custom_product_id?: string | null;
    product?: { status?: string | null } | null;
    variant?: { is_active?: boolean | null } | null;
    custom_product?: { status?: string | null } | null;
  }[],
): UnavailableCartItem[] {
  const out: UnavailableCartItem[] = [];
  for (const it of items) {
    // Explicit nulls only (a loaded row): a deleted product cascades to its
    // variants, so every catalogue FK of the item was set to null.
    const gone =
      it.product_id === null &&
      it.custom_product_id === null &&
      (it.variant_id === null || it.variant_id === undefined);
    const customOff =
      !!it.custom_product_id &&
      it.custom_product?.status != null &&
      it.custom_product.status !== 'PUBLISHED';
    const productOff =
      !it.custom_product_id &&
      !!it.product_id &&
      it.product?.status != null &&
      it.product.status !== 'PUBLISHED';
    const variantOff =
      !it.custom_product_id &&
      !!it.variant_id &&
      it.variant?.is_active === false;
    if (gone || customOff || productOff || variantOff) {
      out.push(unavailableEntry(it));
    }
  }
  return out;
}
