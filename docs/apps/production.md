# Production app (`production`) — per-order production checklist

M4.3 (+ M5.4 automation and staff emails). After an order is placed, every
thing to produce on each line — each personalization value, each variant
attribute (colour, size), each designed sign, plus custom items such as
"Packed" — becomes a **check** the workshop ticks off. Progress drives
order filters, an optional status move, and optional staff emails. Nothing
changes for the shopper: the app is post-order only.

---

## Part 1 — for merchants and support

### What it does

- **Checklist per order line**, generated from the order's frozen data
  (personalization values with their group "Item 1/2/…", variant options as
  sold, designer prints), plus per-store default items.
- **Progress** per order: not started / in progress / ready, with the date
  it completed.
- **Status help**: at 100 % the dashboard **suggests** (or, for quality
  check, automatically performs) the next status; the first tick can move
  the lines to "Manufacturing"; when the designer's print files are ready the
  order can move to Processing / Manufacturing.
- **Staff emails** (opt-in): one email per new order to produce, and a daily
  digest at 07:00 store time of orders still open.
- An append-only **activity log** of who ticked what.

### What changes in the dashboard

- `/creator/production` — **Queue** (orders with progress, filters) and
  **Settings** (`app/creator/production/page.tsx`,
  `components/production/ProductionQueue.tsx`, `ProductionSettingsPanel.tsx`
  with a one-click **Namez preset**).
- `/production/orders/[id]` — mobile **workshop screen** (tick checks, add
  custom items, download print files) and `/production/orders/[id]/sheet` —
  printable **A4 sheet**.
- Orders list: progress column and `?production=in_production|ready|not_started`
  filter (`orders.controller.ts`); order detail: checklist card and
  activity log.
- The creator's status dropdown offers **Quality check** only while the app
  is on and `use_quality_check` is true (M4.3-A).

### When it is off (G0)

No checks are created (`ProductionTriggersService.onOrderCreated` returns
after one cached `isEnabled`), every `/production/my/*` route answers 403,
the orders filter is ignored, and the QC option is hidden. Existing check
rows stay in the database (they cascade with the order).

### How to enable

Any store type. Admin → available; creator → enable; open Settings, apply
the Namez preset or set your own rules, then press **backfill** once to
build checklists for orders placed before enabling
(`POST /production/my/backfill`, runs in batches with "continue").

### Settings (`StoreApp.settings`, validated by `src/modules/production/production-settings.ts`)

Unknown keys are **refused**.

| Key | Meaning | Default | Valid values |
|---|---|---|---|
| `include_variant_options` | Variant attributes (e.g. colour) become checks | `true` | boolean |
| `exclude_option_names` | Variant attribute names never turned into checks (e.g. the quantity attribute) | `[]` | ≤ 20 texts, ≤ 80 chars; matched case/accent-insensitively, `pa_` prefix ignored |
| `exclude_field_types` | Field types never turned into checks | `[]` | values of `CustomFieldType` |
| `exclude_field_names` | Field names or labels never turned into checks | `[]` | ≤ 50 texts |
| `default_custom_items` | Extra checks on every line ("Packed") | `[]` | ≤ 10 texts, ≤ 80 chars |
| `on_complete` | At 100 %: do nothing, suggest the next status, or move automatically | `suggest` | `none` \| `suggest` \| `auto` |
| `complete_target` | Status suggested / applied at 100 % | `QUALITY_CHECK` | `QUALITY_CHECK` \| `SHIPPED` |
| `start_on_first_check` | First tick moves CONFIRMED / PROCESSING lines to MANUFACTURING | `false` | boolean |
| `use_quality_check` | Offer QUALITY_CHECK in the status dropdown | `true` | boolean |
| `on_print_ready` | When every designer print file of the order is READY, move it (forward only, once) to | `none` | `none` \| `PROCESSING` \| `MANUFACTURING` |
| `ship_prompt` | The "mark shipped" suggestion asks for tracking | `tracking_optional` | `none` \| `tracking_optional` \| `tracking_required` |
| `notify_new_order` | Email staff for each new order to produce | `false` | boolean |
| `notify_email` | Recipient; null = the store's contact email | `null` | email ≤ 254 chars, or null |
| `notify_daily_digest` | Daily email at 07:00 store time listing open orders | `false` | boolean |

Cross-field rules: `on_complete: "auto"` cannot target `SHIPPED` (shipping
captures the payment and emails the customer, so it is always manual);
`complete_target: QUALITY_CHECK` with `on_complete ≠ none` needs
`use_quality_check: true`.

### Worked example — Namez (`PRODUCTION_PRESETS.namez`)

```json
{ "include_variant_options": true,
  "exclude_option_names": ["Välj antal", "Räkna", "Välj antal 3D bokstav", "Namnskylt stor bokstav"],
  "on_complete": "suggest", "complete_target": "SHIPPED",
  "use_quality_check": false, "start_on_first_check": false,
  "default_custom_items": [] }
```

A sign order "Namnskylt, colour Gul, Namn: Anna" gets two checks (colour
"Gul", name "Anna"); the quantity attribute is not a check. When both are
ticked the order shows "Ready" and the dashboard suggests **Shipped** with a
tracking-number dialog. With the designer on, add `"on_print_ready":
"PROCESSING"` to move paid designer orders forward once their print file is
rendered.

### Limits and known gaps

- Accepted risk (PROGRESS.md 4.3.1): a QC rejection on an order with mixed
  lines leaves the order in QC.
- Variant-option checks of orders placed **before**
  `variant_options_snapshot` existed (migration `20261028120000`) are built
  from the live variant and are insert-only (never reset or marked stale).
- Labels are snapshotted in the store's primary locale.
- `on_complete: auto` only goes to QUALITY_CHECK; shipping is always a
  person's decision.
- The daily digest depends on the hourly retention scheduler running
  somewhere (`RETENTION_SCHEDULER`), uses the invoices legal profile's time
  zone (default `Europe/Stockholm` when there is none) and lists at most
  200 orders.
- Stores created before the app need
  `seed-store-email-templates.ts --slug <slug> --only-missing` for the
  `production_new_order` template (DEPLOY-M4.md §6). The digest uses a
  bundled template only.

---

## Part 2 — for developers and operators

### Files

`src/modules/production/`: `production-settings.ts`,
`production-checklist.service.ts` (sync / lazy repair / backfill / checks),
`production-sources.ts` (field values, variant options, custom items),
`production-design.provider.ts` (designer source, registered by the
designer — seam C27: one `design:<OrderItemDesign.id>` check per designed
line + print files), `production-automation.service.ts` (on-complete and
print-ready moves), `production-notifications.service.ts`,
`production-triggers.service.ts` (hooks in OrdersService and the designer
print queue; never throw), `production-workspace.ts`, `production-state.ts`,
`production-where.ts` (orders filter), `production.controller.ts`.
Modules: `production-core.module.ts` (cycle-free core) and
`production.module.ts`. Dashboard: `app/creator/production/page.tsx`,
`app/production/orders/[id]/page.tsx`, `…/sheet/page.tsx`,
`components/production/*`.

### Data model (migrations `20261020130000_fulfillment_quality_check`, `20261020140000_add_production_app`, `20261028120000_order_item_variant_snapshot`)

| Table | Notes |
|---|---|
| `FulfillmentStatus` enum (+) | `QUALITY_CHECK` between MANUFACTURING and SHIPPED (platform-wide, inert without the app) |
| `OrderProductionCheck` | `store_id` (no FK), `order_id`, `order_item_id`, `source` (`FIELD_VALUE`/`VARIANT_OPTION`/`DESIGN`/`CUSTOM`), `source_key` (`fv:<valueId>` \| `opt:<name>` \| `design:<id>` \| `custom:<uuid>`; unique per line), `source_hash`, `label`, `value`, `group_index`, `file_url`, `sort_order`, `done`, `done_at`, `done_by`, `done_by_name`, `stale` (source vanished; excluded from progress) |
| `OrderProductionSummary` | per order: `total`, `done`, `state` (`NONE`/`NOT_STARTED`/`IN_PROGRESS`/`READY`), `completed_at`, `auto_advance_pending`; index `(store_id, state)` for the list filter |
| `OrderProductionEvent` | append-only audit: `action` (`CHECK`, `UNCHECK`, `ADD`, `REMOVE`, `BULK`, `VALUE_CHANGED`, `STALE`, `COMPLETED`, `AUTO_ADVANCE`), actor, `payload` |
| `OrderItem` (+) | `variant_options_snapshot` |

All cascade with the order; nothing is backfilled for stores without the app.

### API routes (`CREATOR`, `@RequireApp('production')`, prefix `/api/production/my`)

| Method + path | Purpose |
|---|---|
| `GET settings` | effective settings + `presets` |
| `GET summaries?order_ids=` | progress of several orders (list column; `order_ids` is a list of UUIDs) |
| `POST backfill` | build checklists for existing orders (batched) |
| `GET orders/:orderId` | workspace / sheet (syncs first; runs an owed auto-advance) |
| `GET orders/:orderId/events?page&limit≤200` | activity log |
| `PUT checks/:checkId` `{done}` | tick / untick |
| `POST orders/:orderId/bulk` `{order_item_id?, done}` | tick all (or one line) |
| `POST orders/:orderId/items/:itemId/checks` `{label}` | add a custom check |
| `DELETE checks/:checkId` | remove a custom check (204) |

Settings are written with `PUT /api/stores/my/apps/production`.

### Events / jobs

- `onOrderCreated` (after `order.create`, outside its transaction): sync the
  checklist, then the opt-in staff email (event `production_new_order`,
  one per order, EmailLog is the rate limit).
- `onPrintReady` (designer print queue) → `on_print_ready` move; the
  `AUTO_ADVANCE` event with reason `print_ready` is the idempotency mark.
- Retention task `production.daily-digest` (hourly scheduler): per store
  with `notify_daily_digest`, at local hour 7, at most once per 20 h
  (event `production_daily_digest`). Preview:
  `POST /api/admin/retention/run?task=production.daily-digest&dry_run=1`.
- A per-order lock prevents a missed "complete" when the last two checks
  are ticked concurrently (PROGRESS.md 4.3.1).

### Env

None of its own; mail goes through the store's mail settings.

### Tests worth running

`npx jest src/modules/production` (checklist, sources, automation,
notifications, settings, controller, workspace).
