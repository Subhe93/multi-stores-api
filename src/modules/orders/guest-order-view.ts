/**
 * The order as the holder of a GUEST ORDER TOKEN may read it (POST
 * /orders/guest result, GET /orders/guest/:id).
 *
 * It starts from the buyer view (buyer-order-view.ts: no commission, no
 * payouts, no supplier amounts, no catalogue internals, no internal
 * timeline rows) and additionally drops the `customer` object. The token
 * was handed to whoever typed the email at checkout, which is not proof of
 * owning the account behind that email, so nothing of the account (profile
 * name, phone, account email and status) may travel with the order. What
 * the guest typed for this order (the address row, the lines) stays.
 * Every other key is kept. Pure.
 */
export function forGuest<T>(order: T): Omit<T, 'customer'> {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return order;
  }
  const { customer: _customer, ...rest } = order as T & { customer?: unknown };
  void _customer;
  return rest as Omit<T, 'customer'>;
}
