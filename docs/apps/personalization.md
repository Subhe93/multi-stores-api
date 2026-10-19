# Personalization app (`personalization`) — advanced product fields

M4.1, on top of the platform-wide M4.0 custom-field fixes. Turns the plain
product custom fields (text, select, upload, …) into a personalization
form like WooCommerce PPOM: **repeating groups** ("name 1 … name 4"),
**conditional** fields, **priced** options, ready-made **presets**, a
store-wide **field library**, **variation cards** with images and badges,
and **URL prefill**. Applies only to the creator's **own** products (not to
provider catalogue products). Namez's 14 PPOM templates were imported into
it.

---

## Part 1 — for merchants and support

### What it adds

- Three field types only available with the app: **checkbox group**,
  **colour palette**, **repeater** (a group of child fields repeated N times,
  N often driven by a variant option such as "Antal").
- Per field: **conditions** (show when an option / another field has a
  value), **pricing** (a price per chosen value, per character, …, charged on
  top of the variant price), **repeat** settings, **display** options
  (label, sub-label, note, help text, help image, custom messages per
  language).
- **Presets** that create a full set of fields in one click
  (`src/modules/personalization/presets/`: `single_name`,
  `names_equal_length`, `name_color_per_item`, `engravings`,
  `checkbox_group`).
- **Library**: save a set of fields as a store template and insert it into
  other products.
- **Variation cards**: variant options rendered as cards with image, price
  and badges (e.g. "free shipping" when the card price reaches the shipping
  threshold).
- **URL prefill**: a link like `…/products/x?name1=Anna&color=Blå` fills the
  form.

### What the shopper sees when it is on

The product page renders the advanced form
(`multi-stores-web/src/components/product/personalization/PersonalizationForm.tsx`,
`VariantCards.tsx`, `HelpModal.tsx`); after a failed add to cart a summary
lists the missing fields; the live price includes the personalization
amount; the cart and order show the values **grouped per item**. Prices of
priced options are computed **on the server** and converted for the market.

### What changes in the dashboard

- `/creator/personalization` with tabs **Settings**, **Presets**, **Library**
  (`app/creator/personalization/page.tsx`,
  `components/apps/personalization/*`).
- The product editor's custom-field manager gets the condition, pricing,
  repeat and display editors and "apply preset" / "insert from library".
- Order pages show grouped values (`GroupedOrderFieldValues.tsx`).

### When it is off (G0)

Products fall back to the M4.0 behaviour: the storefront gets only
top-level fields of M4.0 types **without** the M4.1 columns
(`shapeFieldsForStorefront(fields, false)` in `personalization-runtime.ts`),
so a product without advanced config serves a byte-identical payload.
Advanced fields are kept in the database (switching back on restores
them), but while off, children of repeaters and app-only field types are
**not shown** to shoppers. The settings are not in the storefront payload
and the validation route answers 403.

### How to enable

Any store type (`requires_independent: false`). Admin → available, creator
→ enable at `/creator/apps`, then configure `/creator/personalization` and
the product fields.

### Settings (`StoreApp.settings`, validated by `src/modules/personalization/personalization-settings.ts`)

Unknown keys are ignored. "Public" = sent to the storefront payload.

| Key | Meaning | Default | Valid values | Public |
|---|---|---|---|---|
| `free_shipping_badge` | Variation cards show "free shipping" when the card price reaches the threshold | `true` | boolean | yes |
| `free_shipping_country` | Country whose threshold the badge uses; null = market / store country | `null` | ISO2 or null | no |
| `card_price_mode` | Card price = the variant matching current picks, or always "from <min>" | `selection` | `selection` \| `from` | yes |
| `validation_summary` | Show the list of missing fields after a failed add to cart | `true` | boolean | yes |
| `url_prefill` | URL parameter → field name, or `option:<Option name>` | `{}` | ≤ 20 entries; param 1–40 chars of `A-Z a-z 0-9 _ - [ ] .`; target ≤ 120 chars, not empty, not bare `option:` | yes |
| `listing_cta` | Quick-add on listings links to the product's form (`personalize`) or does nothing special (`none`) | `personalize` | `personalize` \| `none` | yes |
| `retention_days` | Days customer uploads are kept after the order | `60` | integer 7–730 | no |

When a field is renamed, the app rewrites matching `url_prefill` targets
itself and drops the store's cached settings (`StoreAppsService.settingsChanged`).

### Worked example — Namez

Namez links its campaigns as `?name1=…&color=…`:

```json
PUT /api/stores/my/apps/personalization
{ "enabled": true,
  "settings": { "url_prefill": { "name1": "<field name of name 1>", "color": "option:<colour option name>" },
                "card_price_mode": "selection", "free_shipping_badge": true,
                "listing_cta": "personalize", "retention_days": 60 } }
```

(The exact Namez field and option names come from the imported products;
they are not fixed in code.) A "names of equal length" sign uses the
`names_equal_length` preset; an engraving product uses `engravings` with
`count_option` "Antal inskriptioner" (the preset's default) so the number of
engraving fields follows the chosen variant.

### Limits and known gaps

- Own products only; custom (provider) products are untouched.
- `preset_ref` is not copied when a product is duplicated (PROGRESS.md
  4.1.1 decision): the copy keeps the fields but loses the link to the preset.
- Renaming or deleting a variant option that a field depends on is
  refused (PROGRESS.md 4.1.2 fixes); rename options in the field editor
  first.
- Merchant regex patterns: dangerous patterns are refused at save time and
  run with a 50 ms server timeout; max 500 characters (PROGRESS.md M4.0).
  Run `node scripts/report-unsafe-patterns.js` after a deploy.
- Not live-tested at the M4.1 sign-off: guest cart, the field library, the
  free-shipping badge (PROGRESS.md 4.1.1 "غير مختبر حياً"). A real-DB e2e
  test was added later (M5 W1, `test/personalization.e2e-spec.ts`).

---

## Part 2 — for developers and operators

### Files

`src/modules/personalization/`: `personalization-settings.ts`,
`personalization-config.validator.ts` (field config rules),
`personalization-runtime.ts` (gates, storefront shaping, cart lines),
`personalization.service.ts` (storefront validation, product writes),
`personalization-field-writer.ts`, `personalization-option-refs.ts`
(option rename/delete guard), `personalization-presets.service.ts` +
`presets/*`, `personalization-library.service.ts`,
`personalization-retention.policy.ts`, `personalization.errors.ts`. Shared
evaluator: `src/common/personalization/` (mirrored in the web app; keep in
sync — M5-PLAN M5.3). Web: `components/product/personalization/*`,
`lib/personalization/prefill.ts`. Dashboard: `components/apps/personalization/*`.

### Data model (migration `20261020120000_add_personalization`; platform M4.0 migrations `20261019120000_m4_0_order_field_snapshot`, `20261019130000_m4_0_customer_uploads`)

| Table | Columns added |
|---|---|
| `CustomFieldType` enum | `CHECKBOX_GROUP`, `COLOR_PALETTE`, `REPEATER` |
| `ProductCustomField` | `parent_id` (self FK, cascade), `conditions`, `pricing`, `repeat`, `ui` (JSON), `preset_key` (varchar 48), `preset_ref` (varchar 191) |
| `CustomFieldTranslation` | `display_label`, `sublabel`, `note`, `help_text`, `help_image_url`, `messages` JSON |
| `OrderCustomFieldValue` | `group_key`, `group_index`, `group_label` JSON, `source` (`FIELD` default), `price_delta` (default 0), `meta` JSON |
| `OrderItem` | `personalization_amount` Decimal (per unit) |
| `PersonalizationFieldTemplate` | library: `store_id`, `name`, `definition` JSON |

Variation cards live in `Product.variant_option_config` (`style: 'card'`,
`valueMeta`), not in a new column. Everything is nullable or defaulted;
nothing is backfilled.

### API routes

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/personalization/my/presets` | CREATOR + app | preset catalogue with parameters |
| `POST /api/personalization/my/products/:productId/presets/:key` | same | create the preset's fields on a product |
| `GET/POST /api/personalization/my/library`, `PUT/DELETE /api/personalization/my/library/:id` | same | library CRUD |
| `POST /api/personalization/my/products/:productId/library/:id` | same | insert a library template |
| `POST /api/storefront/:slug/personalization/validate` | public, 60/min/IP, `@RequireApp` | server-side validation and price of a form state |

Field CRUD itself stays on the platform's product custom-field routes
(`src/modules/custom-fields/custom-fields.service.ts`); writing M4.1 config
while the app is off answers `403 PERSONALIZATION_APP_REQUIRED` (also for
variation-card config in `products.service.ts`); invalid config answers
`400 PERSONALIZATION_CONFIG_INVALID` with the per-field errors.

### Pricing

The personalization delta is computed on the server only, converted for the
market, added **before** the bundle discount, and mirrored in Kustom lines
(PROGRESS.md 4.1-C). The order keeps per-value `price_delta` and the line's
`personalization_amount`.

### Retention

`PersonalizationRetentionPolicy` registers with `CustomerUploadsService`:
while the app is on, customer uploads are kept `retention_days` after the
order (default 60); otherwise the platform default applies
(`CUSTOMER_UPLOAD_RETENTION_DAYS`, forever by default;
orphans after `CUSTOMER_UPLOAD_ORPHAN_DAYS`, 30). Sweeper: retention task
`customer-uploads`.

### Env

No app-specific variable. Customer uploads: `CUSTOMER_UPLOAD_DAILY_BYTES_PER_IP`
(500 MB), `CUSTOMER_UPLOAD_MIN_FREE_MB` (1024), the two retention variables
above; nginx `client_max_body_size 50m` on `/api/uploads/customer`.

### Tests worth running

`npx jest src/modules/personalization` (config validator, presets/library,
runtime, settings, storefront controller, `personalization-m41-fixes.spec.ts`);
real Postgres: `PERSONALIZATION_E2E_DATABASE_URL=… npm run test:e2e --
personalization`; web: `npx vitest run src/components/product/personalization`.
