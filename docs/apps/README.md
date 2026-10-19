# Store apps — per-app documentation

A *store app* is an optional feature that is switched on per store. A store
with no apps behaves exactly as a store without the apps system (the **G0
rule**: with an app off, every payload, price, email and page is the same as
before the app existed). Each app has two switches:

1. **available** — an admin allows the app for the store
   (`PUT /api/stores/by-creator/:creatorId/apps/:appKey/available`,
   dashboard: admin → creator → "Store apps" card, or admin → "Store apps").
2. **enabled** — the creator switches it on in the dashboard
   (`/creator/apps`, `PUT /api/stores/my/apps/:appKey` with `{ enabled, settings? }`).

The app is in effect only when both are true (`isStoreAppRowActive` in
`src/modules/store-apps/storefront-apps.ts`).

| App | Key | Independent stores only | Depends on | One line | Doc |
|---|---|---|---|---|---|
| Markets | `markets` | yes | — | Several domains, currencies and default languages for one store (namez.se SEK + namez.shop EUR). | [markets.md](./markets.md) |
| B2B / company buyers | `b2b` | no | — | "Person / company" switch, company fields, net prices, EU reverse charge with VIES. | [b2b.md](./b2b.md) |
| Invoices | `invoices` | yes | — | Gapless invoice and credit-note numbers, immutable PDF invoices in the order's language and currency. | [invoices.md](./invoices.md) |
| Importer | `importer` | yes | `markets` | Moves a WooCommerce catalog (products, variations, categories, PPOM/NPP fields, media, shipping, 301 redirects) into the store. | [importer.md](./importer.md) |
| Personalization | `personalization` | no | — | Advanced product fields: repeaters, conditions, priced options, presets, variation cards, URL prefill. | [personalization.md](./personalization.md) |
| Production | `production` | no | — | Per-order production checklist, workshop screen, print sheet, status automation, staff emails. | [production.md](./production.md) |
| Designer | `designer` | yes | — | Product designer: templates in mm, in-page canvas editor, server-rendered print PNG/PDF, paid add-ons. | [designer.md](./designer.md) |
| Feeds | `feeds` | no | — | Google Merchant RSS and Meta catalog CSV per market from secret token URLs. | [feeds.md](./feeds.md) |

## Shared mechanics (all apps)

- **Registry** (keep the four copies identical):
  `multi-stores-shared/src/constants/store-apps.ts` (source of truth),
  `multi-stores-api/src/common/store-apps/store-apps.registry.ts`,
  `multi-stores-dashboard/src/lib/storeApps.registry.ts`,
  `multi-stores-web/src/lib/storeApps.ts`. Each entry declares
  `requires_independent`, `depends_on`, `expose_settings_to_storefront` and an
  optional `public_settings_keys` whitelist.
- **Table** `StoreApp` (migration `20261014120000_add_store_apps`):
  `store_id`, `app_key` (varchar 32), `available`, `enabled`, `settings`
  (JSON, default `{}`), `enabled_at`, `enabled_by`; unique `(store_id, app_key)`.
- **Settings validation**: `PUT /api/stores/my/apps/:key` runs the app's
  validator from `src/common/store-apps/settings-validators.ts` and answers
  `400 STORE_APP_SETTINGS_INVALID` with the joined messages. Apps without a
  validator (`markets`, `importer`) accept any object; they keep their
  configuration in their own tables instead.
- **Errors** (`src/modules/store-apps/store-apps.service.ts`):
  `STORE_APP_NOT_AVAILABLE` (403), `STORE_APP_REQUIRES_INDEPENDENT`,
  `STORE_APP_DEPENDENCY_MISSING`, `STORE_APP_DEPENDENCY_IN_USE` (400),
  `STORE_APP_UNKNOWN` (404). App-gated routes use `@RequireApp(key)` +
  `RequireAppGuard` and answer `403 STORE_APP_NOT_ENABLED`.
- **Store type change**: when an admin switches a store away from
  INDEPENDENT, every independent-only app and its dependents are switched
  off (`onStoreTypeChanged`); availability is kept.
- **Storefront payload**: `GET /api/storefront/:slug` always carries `apps`
  (`{}` when none); an app in effect appears as `{ enabled: true }` plus its
  whitelisted public settings when it exposes any (`buildStorefrontApps`).
- **Cache**: per-instance 60 s TTL plus `pg_notify('store_apps', storeId)` on
  every change so other PM2 instances drop their entry at once
  (`STORE_APPS_LISTEN=off` disables the listener). See
  [../OPERATIONS.md](../OPERATIONS.md) §2.
- **Admin overview**: `GET /api/stores/admin/apps` (paginated, `q`, `type`)
  and `GET /api/stores/by-creator/:creatorId/apps`.

Related operator docs: [../OPERATIONS.md](../OPERATIONS.md) (env, workers,
backups, ops status), [../DEPLOY-M4.md](../DEPLOY-M4.md) (rollout and the
"enabling for a store" order), [../DATA-MODEL-CONVENTIONS.md](../DATA-MODEL-CONVENTIONS.md)
(scope columns without FK and their sweepers). Planning history:
`plans/namez-store-apps/` (PLAN.md, PROGRESS.md, M*-DESIGN.md, M5-PLAN.md).
