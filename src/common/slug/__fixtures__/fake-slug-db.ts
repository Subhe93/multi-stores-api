/*
 * In-memory stand-in for the Prisma calls the slug rule makes
 * (findFirst / findMany / findUnique with nested relation filters, `not`,
 * `in`), used by the write-path specs. Rows embed their relation objects,
 * e.g. a productTranslation row carries `product: { id, creator_id }`.
 */

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond === undefined) continue;
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('not' in c) {
        if (
          c.not === null
            ? value === null || value === undefined
            : value === c.not
        )
          return false;
        continue;
      }
      if ('equals' in c) {
        const ok =
          c.mode === 'insensitive'
            ? typeof value === 'string' &&
              value.toLowerCase() === String(c.equals).toLowerCase()
            : value === c.equals;
        if (!ok) return false;
        continue;
      }
      if ('in' in c) {
        if (!(c.in as unknown[]).includes(value)) return false;
        continue;
      }
      if ('some' in c) {
        const list = (value as Row[] | undefined) ?? [];
        if (!list.some((r) => matches(r, c.some as Row))) return false;
        continue;
      }
      if (value === null || typeof value !== 'object') return false;
      if (!matches(value as Row, c)) return false;
      continue;
    }
    if ((value ?? null) !== cond) return false;
  }
  return true;
}

/** Reads return copies, like Prisma, so later writes do not alter them. */
export function table(rows: Row[] = []) {
  const one = ({ where }: { where?: Row } = {}) => {
    const r = rows.find((x) => matches(x, where));
    return Promise.resolve(r ? { ...r } : null);
  };
  return {
    rows,
    findFirst: jest.fn(one),
    findMany: jest.fn(({ where }: { where?: Row } = {}) =>
      Promise.resolve(
        rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
    ),
    findUnique: jest.fn(one),
  };
}

/** A store row as `storeSlugLocale` / `productSlugContext` read it. */
export function storeRow(
  id: string,
  creatorId: string,
  primaryLocale: string,
): Row {
  return {
    id,
    creator_id: creatorId,
    language_config: { primary_locale: primaryLocale },
  };
}
