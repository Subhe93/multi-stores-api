# Data model conventions

Rules that `schema.prisma` cannot express by itself. Read with
[prisma/RAW-SQL.md](../prisma/RAW-SQL.md) (hand-written DB objects) and
[DEPLOY-M4.md](./DEPLOY-M4.md) (migration procedure).

## 1. Scope columns without a foreign key need a retention sweeper

A *scope column* is a `store_id` / `creator_id` / `customer_id` / `order_id`
style column that only tells which tenant a row belongs to. Most of them are
real foreign keys with `onDelete: Cascade`, so a store deletion removes the
rows. Some are **plain strings on purpose**: the row must outlive the parent
(accounting, evidence), the parent may legitimately be gone (a purged draft),
or the column is a denormalised copy for indexing.

The rule: **a scope column without a FK is allowed only when the table has a
sweeper** (a registered retention task, an inline prune, or a documented
"kept forever" decision), because nothing else will ever delete those rows
once the parent is gone. Every such column is listed here; add a row when you
add one, and point at its sweeper.

| Table.column | Why no FK | Sweeper / lifetime |
| --- | --- | --- |
| `ImportEntity.store_id`, `ImportMedia.store_id` | the ledger and the media index must survive a run's deletion and are keyed by store only (fix 22) | `importer.bundles` (`ImporterRetentionTask`): rows (and the media's private files) of stores that no longer exist are deleted every run |
| `ImportEntity.first_run_id`, `ImportMedia.first_run_id`, `ImportEntity.last_run_id` | runs are purged after 180 days, the ledger is not | same task; the ids stay as history (never dereferenced after the run is gone) |
| `ImportRunItem.target_id`, `ImportEntity.target_id` | polymorphic (product, collection, redirect, template, …) | goes with the run (`ImportRunItem`) / is re-validated on every plan (`ImportEntity`, a missing target is "not tracked") |
| `ImportRun.worker_id` | the claim token of an in-process worker, not a row | cleared by the worker on release; `requeueStale` clears stale claims |
| `StoreRedirect.import_run_id` | redirects outlive the run that wrote them (180 days) | kept; rollback deletes the run's rows while the run exists |
| `CustomerUpload.store_id` | an upload is created before the order (no store yet), then claimed by one store | `customer-uploads.retention` (`CustomerUploadsService.runRetention`): attached uploads per store policy, orphans after `CUSTOMER_UPLOAD_ORPHAN_DAYS` |
| `DesignAsset.store_id` | customer photos and template assets are addressed by key and may be shared by several designs / versions | `designer.orphans`, `designer.originals`, `designer.files` (`DesignerRetentionService`), `purged_at` marks the file sweep |
| `OrderItemDesign.design_id`, `OrderItemDesign.store_id`, `OrderItemDesign.template_id` | the draft may be purged while the order keeps its snapshot; store/template are denormalised for the print-queue indexes | the row cascades with its `OrderItem`; `designer.files` purges the print files |
| `Design.customer_id` | guest designs have no customer; a deleted customer keeps nothing | `designer.drafts` purges drafts; ordered designs cascade with the store |
| `Invoice.store_id`, `Invoice.legal_profile_id` | legal documents survive store deletion (and the immutability trigger forbids deleting them) | kept forever by design (`prisma/sql/invoice-guards.sql`); no sweeper |
| `OrderProductionCheck.store_id`, `OrderProductionSummary.store_id` | denormalised scope for the production workspace indexes (like `Invoice.store_id`) | cascade with the `Order` (FK on `order_id`) |
| `Order.store_id`, `Cart.store_id` | orders survive store deletion (accounting); the cart is per customer across stores | `Order`: kept; `Cart`: rows go with the customer (`customer_id` FK) |
| `Order.stripe_*`, `Order.kustom_*`, `Creator.stripe_account_id`, `Creator.kustom_merchant_id`, `PlatformConfig.kustom_partner_id`, `OrderPayout.stripe_transfer_id` | identifiers of an external system | kept with the row |
| `OrderPayout.recipient_id`, `OrderItem.fulfiller_id` | the payee / fulfiller may be a creator or a provider (polymorphic) | cascade with the order |
| `EmailLog.store_id`, `EmailLog.order_id` | delivery log, read for diagnostics only | inline prune in `MailService` (`EMAIL_LOG_RETENTION_MS`, checked every `EMAIL_LOG_PRUNE_EVERY_MS`) |
| `VatNumberCheck.store_id` | VIES evidence must survive the store (and may be platform-wide) | kept forever (evidence); the cache rows are keyed by VAT number, not store |
| `PromotionUsage.user_id`, `Notification.user_id`, `OrderProductionEvent.actor_id` | the user may be deleted while the usage / notification / audit row stays | `PromotionUsage` and `OrderProductionEvent` cascade with the order; `Notification` rows are deleted by the user's own "clear" action only |
| `UploadQuotaWindow.scope/key`, `OpsJobTick.job/instance` | not entities at all (counters keyed by text) | `ops.quota-windows` (2 days), `ops.job-ticks` |

Sweepers run on the hourly retention scheduler (`RetentionService`, see
OPERATIONS.md); `POST /api/admin/retention/run?dry_run=1` lists every task.

### Checklist for a new scope column

1. Prefer a real relation with `onDelete: Cascade` (or `SetNull` when the row
   must stay). Reach for a plain column only for one of the three reasons
   above, and say which one in a schema comment (`// no FK on purpose, …`).
2. Add an `@@index` on the column (the sweeper and the per-store reads need
   it).
3. Register the sweeper as a retention task, or write "kept forever" here
   with the reason.
4. Add the row to the table above.

## 2. String or enum

Use a Prisma **enum** when the set of values is closed, owned by this code
base and branched on (`switch` with every member): run and entity statuses
(`ImportRunStatus`, `ImportEntityStatus`, `ImportItemAction`,
`ImportItemPhase`), `RedirectSource`, `EmailLogStatus`, `VatCheckStatus`,
`DesignStatus`, `ProductStatus`, … A new member needs a migration (`ALTER
TYPE … ADD VALUE`), which is the point: every reader is updated with it.

Use a **string with a `@db.VarChar(n)` cap** when the set is open or owned by
something else:

- extensible vocabularies filled by apps, profiles or adapters:
  `ImportRunItem.entity_type` / `ImportEntity.entity_type` (a new import
  entity type must not need a migration), `StoreApp.app_key`,
  `UploadQuotaWindow.scope`, `OpsJobTick.job`, `Market.key`, `TaxClass.key`,
  `Menu.key`, `PageSection.section_key`, `ProductCustomField.preset_key`;
- codes copied from an external system: `Order.payment_status`,
  `OrderPayout.status`, `VatNumberCheck.source` / `mode`,
  `Creator.stripe_account_type`, `Creator.kustom_capture_mode`;
- free-form event / action names used for display and audit:
  `OrderProductionEvent.action`, `Notification.type`, `EmailLog.event`,
  `OrderTimeline.status`.

A string column is validated in code at the boundary (DTO `@IsIn`, the
importer's `normalizeRunOptions`, the registry of store apps) and is never
switched on exhaustively; unknown values must be tolerated by every reader
(they come from older rows or newer writers). When a string column starts to
drive behaviour with an exhaustive `switch`, promote it to an enum with a
migration.
