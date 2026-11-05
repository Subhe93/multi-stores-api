import { allocateLargestRemainder } from './tax.util';

/**
 * Split an order's aggregate provider share (minor units) across its
 * providers, pro-rata to each provider's base, so the per-provider amounts sum
 * to `poolMinor` exactly (largest remainder). Providers are ordered by id, so
 * the result never depends on the order the items were loaded in.
 *
 * Used by PaymentsService.issueOrderTransfers (the transfers) and by the
 * provider earnings ledger, which must show the very same amounts.
 */
export function splitProviderShares(
  poolMinor: number,
  items: {
    fulfiller_id: string;
    provider_base_amount: unknown;
  }[],
): Map<string, number> {
  const baseByProvider = new Map<string, number>();
  for (const i of items) {
    baseByProvider.set(
      i.fulfiller_id,
      (baseByProvider.get(i.fulfiller_id) || 0) +
        Number(i.provider_base_amount || 0),
    );
  }
  const ids = [...baseByProvider.keys()].sort();
  const result = new Map<string, number>();
  if (poolMinor <= 0) {
    for (const id of ids) result.set(id, 0);
    return result;
  }
  // Weights in minor units keep float noise out of the remainders.
  const weights = ids.map((id) =>
    Math.round((baseByProvider.get(id) || 0) * 100),
  );
  const shares = allocateLargestRemainder(poolMinor, weights);
  ids.forEach((id, idx) => result.set(id, shares[idx]));
  return result;
}
