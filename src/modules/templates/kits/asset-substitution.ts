// Deep-walk a settings/content value and replace every "@asset/<key>" string
// with its resolved URL from the asset map. Unmapped keys resolve to '' so the
// storefront sections fall back to their empty/placeholder state rather than
// rendering a broken "@asset/..." literal. Pure and immutable — returns a new
// structure, never mutates the input.

const ASSET_PREFIX = '@asset/';

export function substituteAssets<T>(value: T, map: Record<string, string>): T {
  if (typeof value === 'string') {
    if (value.startsWith(ASSET_PREFIX)) {
      const key = value.slice(ASSET_PREFIX.length);
      return (map[key] ?? '') as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteAssets(item, map)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteAssets(v, map);
    }
    return out as unknown as T;
  }
  return value;
}
