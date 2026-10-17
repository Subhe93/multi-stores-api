/**
 * READ-ONLY report (M5 A4, M4.0 §10 audit): lists custom fields whose
 * `linked_validation` still carries the legacy `target_field_id` key (the
 * pre-K3 dashboard wrote the sibling NAME there, older rows an id), and what
 * it resolves to today: a sibling name, a sibling id, or nothing. Nothing is
 * changed: renames migrate such rows to `target` as they happen
 * (`CustomFieldsService.renameLinkTargets`), and the storefront rules read
 * both keys (`readLinkedValidation`).
 *
 *   node scripts/report-legacy-link-targets.js          (table)
 *   node scripts/report-legacy-link-targets.js --json   (JSON)
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

(async () => {
  try {
    // Rows whose link JSON has the legacy key (jsonb `?` operator).
    const legacy = await prisma.$queryRaw`
      SELECT f."id", f."product_id", f."name", f."parent_id", f."linked_validation"
      FROM "ProductCustomField" f
      WHERE f."linked_validation" ? 'target_field_id'
      ORDER BY f."product_id", f."sort_order", f."id"`;
    const productIds = [...new Set(legacy.map((r) => r.product_id))];
    const siblings = productIds.length
      ? await prisma.productCustomField.findMany({
          where: { product_id: { in: productIds } },
          select: { id: true, product_id: true, name: true, parent_id: true },
        })
      : [];
    const rows = legacy.map((r) => {
      const link = r.linked_validation || {};
      const value =
        typeof link.target_field_id === 'string'
          ? link.target_field_id.trim()
          : '';
      const target = typeof link.target === 'string' ? link.target.trim() : '';
      const sameSet = siblings.filter(
        (s) =>
          s.product_id === r.product_id &&
          s.id !== r.id &&
          (s.parent_id ?? null) === (r.parent_id ?? null),
      );
      const byName = sameSet.find((s) => s.name === value);
      const byId = sameSet.find((s) => s.id === value);
      return {
        field_id: r.id,
        field_name: r.name,
        product_id: r.product_id,
        target_field_id: value,
        target: target || null,
        resolves_to: byName
          ? `name:${byName.name}`
          : byId
            ? `id:${byId.id} (${byId.name})`
            : 'NOTHING',
      };
    });
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      const dangling = rows.filter((r) => r.resolves_to === 'NOTHING').length;
      console.log(
        `${rows.length} field(s) still carry linked_validation.target_field_id; ${dangling} resolve to nothing.`,
      );
      if (rows.length) console.table(rows);
    }
  } catch (e) {
    console.error('ERR:', e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
