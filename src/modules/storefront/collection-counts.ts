import type { PrismaService } from '../../prisma/prisma.service';

// Published-product counts per creator collection (M4.4). Only used for
// collections flagged `noindex_when_empty`, so stores without such a flag
// never pay for these queries.

export interface CountableCollection {
  id: string;
  match_rule: 'MANUAL' | 'TAGS' | string;
  match_tags: string[];
}

/**
 * Number of PUBLISHED products listed by each collection, using the same
 * membership rules as the storefront listing (MANUAL = link rows, TAGS = tag
 * match). Custom products count only for non-independent stores. Market
 * availability is not considered (a market-hidden product still counts), so
 * the count can only err towards "not empty".
 */
export async function countPublishedInCollections(
  prisma: PrismaService,
  creatorId: string,
  includeCustomProducts: boolean,
  collections: CountableCollection[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!collections.length) return counts;
  for (const c of collections) counts.set(c.id, 0);

  const manualIds = collections
    .filter((c) => c.match_rule !== 'TAGS')
    .map((c) => c.id);
  const tagged = collections.filter((c) => c.match_rule === 'TAGS');

  const add = (id: string, n: number) =>
    counts.set(id, (counts.get(id) ?? 0) + n);

  if (manualIds.length) {
    const [own, custom] = await Promise.all([
      prisma.productCreatorCategory.groupBy({
        by: ['creator_category_id'],
        where: {
          creator_category_id: { in: manualIds },
          product: { creator_id: creatorId, status: 'PUBLISHED' },
        },
        _count: { _all: true },
      }),
      includeCustomProducts
        ? prisma.customProductCreatorCategory.groupBy({
            by: ['creator_category_id'],
            where: {
              creator_category_id: { in: manualIds },
              custom_product: { creator_id: creatorId, status: 'PUBLISHED' },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    for (const r of own) add(r.creator_category_id, r._count._all);
    for (const r of custom) add(r.creator_category_id, r._count._all);
  }

  // Tag collections are rare among flagged ones (the importer writes MANUAL);
  // one count per collection keeps the rule identical to the listing.
  await Promise.all(
    tagged.map(async (c) => {
      if (!c.match_tags.length) return;
      const [own, custom] = await Promise.all([
        prisma.product.count({
          where: {
            creator_id: creatorId,
            status: 'PUBLISHED',
            tags: { some: { tag: { in: c.match_tags } } },
          },
        }),
        includeCustomProducts
          ? prisma.customProduct.count({
              where: {
                creator_id: creatorId,
                status: 'PUBLISHED',
                product: { tags: { some: { tag: { in: c.match_tags } } } },
              },
            })
          : Promise.resolve(0),
      ]);
      add(c.id, own + custom);
    }),
  );
  return counts;
}
