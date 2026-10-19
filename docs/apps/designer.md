# Designer app (`designer`) — product designer with server-rendered print files

M4.2 (+ M5 wave 0b fixes, M5.5 in-page editor rebuild, add-ons and print
PDF). Replaces the WooCommerce "NPP" designer of namez.se: the merchant
builds **templates in millimetres** (background, text fields, photo slots,
decorations, fonts), links them to products, the shopper designs the sign
**inside the product page**, and after payment the server renders a
**print file** (PNG 3000×4200 for 500×700 mm, optional PDF with bleed) that
the workshop downloads. Namez runs it in production (9 templates, 24
products, enabled 2026-10-18).

---

## Part 1 — for merchants and support

### What the shopper sees when it is on

- On a linked product the designer canvas replaces the image gallery on
  desktop (the product image shrinks above it; stacked on mobile) and the
  form sits in the summary column
  (`multi-stores-web/src/components/designer/DesignerInline.tsx`,
  `DesignerSession.tsx`). Text fields update the canvas live; photo slots
  accept uploads with drag / zoom / rotate and a **low-resolution warning**
  (never a block).
- One button with the live price validates, saves and adds to cart, and
  follows the store's checkout behaviour (`after_add_to_cart`). Paid
  **add-ons** (e.g. rain cover, extra poster) appear as toggles / quantities.
- The draft autosaves; `?design=<id>` reopens it; the cart line has "edit
  design". After a failed payment the shopper continues from a **copy**
  ("start from this design") because an ordered design is locked.
- The order email shows the design image.

### What changes in the dashboard

- `/creator/designer` with tabs **Templates**, **Assets** (backgrounds,
  decorations, fonts), **Print queue**, **Settings**
  (`app/creator/designer/page.tsx`, `components/designer/*`), and the
  template editor `/creator/designer/templates/[id]` (direct canvas editing,
  snapping guides, undo/redo, publish; "Live vN / unpublished draft" chip).
- Product editor: **Designer** tab (link a template, enable, add-ons —
  `ProductDesignerTab.tsx`, `ProductAddonsEditor.tsx`).
- Order detail: **Designs** card (proof, print download PNG/PDF,
  regenerate, "erase customer files now").
- With [production](./production.md) on: one `design:` check per designed
  line and the print files on the workshop screen and A4 sheet.

### When it is off (G0)

Linked products render as normal products, every designer route for
shoppers answers 403, nothing is queued for printing and no browser is
launched. Orders keep their frozen designs: the creator can still **read**
an order's designs and download print files / originals
(`designer/my/orders/*` is not app-gated; regenerate and erase are).
Retention keeps running on the last saved settings (personal data keeps
expiring).

### How to enable (order matters — DEPLOY-M4.md §7)

1. Store must be **INDEPENDENT** (the creator is the sole fulfiller of
   designed lines).
2. The API must run as a **non-root** user (Chromium sandbox) and have a
   Chromium (`CHROMIUM_PATH` / `DESIGNER_CHROMIUM_PATH`).
3. Admin → available; creator → enable.
4. **Upload the fonts** the templates use (woff2 / ttf / otf; fonts are
   self-hosted, never fetched from Google). Namez: Montserrat
   400/500/600/700, Anton 400, Righteous 400.
5. Build or import templates, **publish** them (a template with missing
   fonts cannot be published).
6. Link products and **enable** each link (for NPP-imported products this
   removes the `npp_fallback` fields the importer created).
7. Test a Kustom playground order with a designer line; check the print
   queue reaches READY and the PNG is 3000×4200.

### Settings (`StoreApp.settings`, validated by `src/modules/designer/designer-settings.ts`)

Unknown keys are ignored. "Public" = sent to the storefront payload.

| Key | Meaning | Default | Valid values | Public |
|---|---|---|---|---|
| `retention_days` | Customer photo originals are deleted this many days after the order (once the print is READY, the order is terminal, or a 7-day grace passed) | `60` | integer 7–730 | no |
| `draft_retention_days` | Unordered drafts (and their photos) expire after this many idle days | `30` | integer 1–730, ≤ `retention_days` | no |
| `print_keep_days_after_shipped` | Print and proof files deleted this many days after shipping | `30` | integer 0–365 | no |
| `max_upload_mb` | Max customer photo upload | `25` | integer 1–40 | yes |
| `min_effective_dpi_warning` | Photos below this effective DPI get a warning | `100` | integer 30–300 | yes |
| `print_px_per_mm` | Print resolution | `6` | only `6` (= 152.4 DPI; 3000×4200 for 500×700 mm) | no |
| `print_formats` | Print outputs; PNG always, PDF with bleed optional | `["png"]` | `["png"]` or `["png","pdf"]` (no duplicates) | no |
| `print_crop_marks` | Crop marks in the print PDF (outside the bleed) | `false` | boolean | no |
| `shop_button_text` | Heading / button text of the inline designer per locale | `{"sv":"Designa din skylt"}` | locale (`xx` or `xx-YY`) → text ≤ 40 chars | yes |

### Add-ons (per product link, `PUT /api/designer/my/products/:productId/addons`, `designer-addons.ts`)

```json
{ "v": 2, "items": [
  { "key": "raincover", "type": "toggle",   "label": {"sv":"Regnskydd","en":"Rain cover"}, "price": 29,  "enabled": true },
  { "key": "poster",    "type": "quantity", "label": {"sv":"Poster 50×70 cm"},            "price": 179, "max_qty": 10, "enabled": true },
  { "key": "double",    "type": "toggle",   "label": {"sv":"Dubbelsidig"},                "price": 149, "enabled": false } ] }
```

Rules: ≤ 10 items; `key` `^[a-z0-9][a-z0-9_-]{0,31}$`, unique; `type`
`toggle` | `quantity`; `price` in the **store base currency**, 0–100 000
(converted for the market at pricing time); `max_qty` 1–20 for quantity
add-ons; labels ≤ 80 chars. The server re-reads the **current** config when
pricing: unknown / disabled keys are ignored and quantities clamped. NPP
imports keep the legacy block (`imported`) and only offer **suggested,
disabled** presets (double 149, rain cover 29, poster 179 × up to 10).

### Worked example — Namez

Settings: defaults, plus `"print_formats": ["png","pdf"]` if the printer
wants a PDF with bleed. Namez has 9 published templates (imported from NPP,
fonts Montserrat / Anton / Righteous) linked to 24 products (PROGRESS.md
5.7). Illustrative add-on setup: adopt the suggested NPP presets and enable
"Regnskydd" (+29 kr) and "Poster 50×70 cm" (+179 kr each, up to 10) — the
prices actually charged are whatever the merchant saves. A shopper on
namez.shop sees the add-on prices converted to EUR. After payment the print queue
renders `…-front.png` (3000×4200, 152 dpi) — measured at ~1.6 s with the
proof on production (PROGRESS.md 5.8).

### Limits and known gaps

- **Welcome sign not supported**: in NPP it is a separate template; the
  importer does not offer it as an add-on (`legacyAddonPresets`).
- **A PDF failure withholds the PNG**: with `pdf` in `print_formats` the job
  is READY only when both files exist (`designer-render.service.ts`), so a
  failing PDF keeps the PNG from the workshop until it is fixed or PDF is
  switched off and the line regenerated.
- **One surface ("front") only**; add-ons such as "double-sided" are priced
  lines — no second print surface is rendered for them.
- Resolution fixed at 6 px/mm (300 DPI is not available yet).
- Text outside the uploaded font's character map would print as boxes:
  saving checks the font's cmap and imported templates restrict
  `allowed_chars` to Latin (M5 C3). Install `fonts-noto` on the server.
- Kustom with a designer line was not tested locally; test it in the
  Kustom playground before relying on it (DEPLOY-M4.md §7.5).
- After a failed payment the shopper needs a new copy of the design
  (accepted M4.2 decision).
- Customer-upload byte quotas: 500 MB / IP / day, 5 GB / store / day, 10
  photos per design (env, below).

---

## Part 2 — for developers and operators

### Files

`src/modules/designer/`: templates (`designer-templates.service.ts` /
`.controller.ts`, `designer-templates.thumbnail`), assets and fonts
(`designer-assets.*`, `designer-fonts.*` incl. cmap parsing), shopper
designs (`designs.service.ts`, `designs.controller.ts`, `designs.util.ts`),
cart / pricing / freeze (`designer-cart.service.ts`, `designer-addons.ts`),
rendering (`designer-render.service.ts`, `render/design-renderer.ts` shared
with the browser, `render/designer-chromium.host.ts`, `render/print-pdf.ts`,
`render/render-page.ts`), print queue (`designer-print-queue.*`),
retention (`designer-retention.*`), signed URLs (`designer-urls.ts`,
`DESIGNER_URL_SECRET`), upload admission / quotas
(`designer-upload-admission.ts`), mail (`designer-mail.extension.ts`),
triggers (`designer-triggers.service.ts`), NPP import (`npp/`), errors
(`designer-errors.ts`). Web: `components/designer/*`, `lib/designer/*`.
Dashboard: `app/creator/designer/**`, `components/designer/*`.

### Data model (migrations `20261026120000_add_designer`, `20261027120000_designer_indexes`, `20261101120000_design_addons_selection`)

| Table | Notes |
|---|---|
| `DesignTemplate` | `status` (`DRAFT`/`PUBLISHED`/`ARCHIVED`), `current_version_id`, `source` (`native`/`npp`), `external_ref` |
| `DesignTemplateVersion` | immutable `spec` JSON (TemplateSpecV1, mm, `surfaces[]`), `spec_sha256`, `thumbnail_url` |
| `ProductDesigner` | per product: `template_id`, `enabled`, `addons` JSON (`{v:2, items, imported?}`) |
| `DesignAsset` | `kind` (`CUSTOMER_PHOTO`, `TEMPLATE_BG_WEB`, `TEMPLATE_BG_PRINT`, `TEMPLATE_DECO`, `TEMPLATE_THUMB`, `FONT`), `private_key`, `preview_key`, `public_url`, size/sha, `meta`, `purged_at`; `store_id` without FK (swept) |
| `Design` | shopper draft: `state` JSON, `state_version` (optimistic concurrency), `addons` (`{key: qty}`), `status` (`DRAFT`/`IN_CART`/`ORDERED`), `customer_id`, `access_token_hash` (guests), proof key/sha |
| `OrderItemDesign` | frozen per order line **and the print queue**: `template_spec`, `state`, `assets`, `text_values`, `price_breakdown` `{designer_delta, addons}`, `renderer_version`, `print_status` (`PENDING`/`RENDERING`/`READY`/`FAILED`/`PURGED`), `print_attempts`, `print_next_attempt_at`, `print_locked_at`, `print_error`, `print_files` `[{surface, format, key, width_px, height_px, dpi, bytes, sha256}]`, `print_requested_at`, `shipped_at`, `terminal_at`, `originals_purged_at`, `files_purged_at` |
| `CartItem` (+) | `design_id` (no FK) |

Partial index `OrderItemDesign_queue_claim_idx` and a GIN index on
`OrderItemDesign.assets` are hand-written (`prisma/RAW-SQL.md`).

### API routes

Creator (`CREATOR`, `@RequireApp('designer')` unless noted):

| Method + path | Purpose |
|---|---|
| `GET/POST /api/designer/my/templates`, `GET/PATCH/DELETE /api/designer/my/templates/:id` | templates |
| `POST /api/designer/my/templates/:id/versions`, `GET …/versions/:versionId`, `POST …/:id/publish` | versions / publish |
| `GET/PUT/DELETE /api/designer/my/products/:productId`, `PUT …/:productId/addons` | product link + add-ons |
| `GET/POST /api/designer/my/assets`, `GET/DELETE …/:id` | template assets (40 MB nginx cap) |
| `GET/POST /api/designer/my/fonts`, `DELETE …/:id` | fonts |
| `GET /api/designer/my/print-queue`, `POST …/print-queue/retry-failed` | queue |
| `POST /api/designer/my/orders/:orderId/items/:itemId/regenerate` | re-render |
| `POST /api/designer/my/orders/:orderId/items/:itemId/purge` | erase customer files now (R5) |
| `GET /api/designer/my/orders/:orderId/designs` | **not gated** — frozen designs |
| `GET /api/designer/my/orders/:orderId/items/:itemId/print?format=pdf` | **not gated** — print PNG/PDF (409 `DESIGNER_PRINT_NOT_READY`, 410 `DESIGNER_FILES_PURGED`) |
| `GET /api/designer/my/orders/:orderId/items/:itemId/originals/:assetId` | **not gated** — customer original |

Shopper (`OptionalJwtAuthGuard` + `@RequireApp('designer')`, prefix
`/api/designer/s/:slug/designs`; guests prove ownership with the design
token): `POST /` (30/min), `GET /:id` (120/min), `POST /:id/duplicate`
(10/min), `PATCH /:id` (120/min), `POST /:id/proof` (20/min),
`POST /:id/photos` (10/min, multipart), `DELETE /:id/photos/:assetId`.
Public files: `GET /api/designer/assets/:file`, `GET /api/designer/fonts/:file`,
`GET /api/designer/files/:token` (signed, 300/min).

### Print queue (worker)

`OrderItemDesign` is the queue. `print_requested_at` is set when the order
is paid (or COD / regenerate). A 15 s worker claims rows with `FOR UPDATE
SKIP LOCKED`, only for stores with the app on and never for terminal orders;
locks older than 10 min are reclaimed; 3 attempts with 1 min / 10 min
backoff; deterministic failures fail at once. An instance without a browser
never burns attempts: it hands the row back and pauses claiming
(`designer-print-queue.service.ts` header). On SIGTERM rendering rows are
handed back (`enableShutdownHooks`). When a print is READY the production
app's `onPrintReady` hook runs.

### Retention (tasks on the hourly scheduler)

`designer.drafts` (R1, idle drafts), `designer.orphans` (R2, photos without
a design after 24 h), `designer.originals` (R3, originals after
`retention_days`), `designer.files` (R4, print + proof files
`print_keep_days_after_shipped` after shipping, 14 days after
cancel/refund, hard cap 365 days). R5 = merchant "erase now". Print files
of open orders are never purged by R4 except by the 365-day cap
(`designer-retention.service.ts` header).

### Env

| Variable | Default | Notes |
|---|---|---|
| `DESIGNER_URL_SECRET` | – | **required in production**, ≥ 32 chars, identical on every instance |
| `DESIGNER_RENDER_QUEUE` (`DESIGNER_WORKER`) / `WORKERS=…designer…` | on | print worker on this instance |
| `DESIGNER_RENDER_ENGINE` | `chromium` | `off` = no browser (`DESIGNER_RENDER_UNAVAILABLE`) |
| `DESIGNER_RENDER_CONCURRENCY` | 1 | 1 or 2 lanes (~250 MB RAM each on top of ~200 MB browser) |
| `DESIGNER_CHROMIUM_PATH` / `DESIGNER_BROWSER_CHANNEL` → `INVOICE_PDF_*` → `CHROMIUM_PATH` / `CHROMIUM_CHANNEL` | – | browser resolution order |
| `DESIGNER_UPLOAD_DAILY_BYTES_PER_IP`, `DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE` | 500 MB, 5 GB | 429 `DESIGNER_UPLOAD_QUOTA` (Postgres counters) |
| `DESIGNER_MAX_PHOTOS_PER_DESIGN` | 10 | |
| `DESIGNER_UPLOAD_MIN_FREE_MB` | = `CUSTOMER_UPLOAD_MIN_FREE_MB` (1024) | 503 `DESIGNER_STORAGE_FULL` |
| `DESIGNER_MAIL_LINK_MAX_DAYS` | 30 | lifetime of signed links in emails |
| `DESIGNER_RENDER_DUMP`, `DESIGNER_RENDER_REAL`, `UPDATE_GOLDEN` | – | **dev/test only**, absent in production |

nginx: `client_max_body_size 40m` on `/api/designer/my/assets` and
`/api/designer/s/*/designs/*/photos`; `proxy_read_timeout ≥ 120s` on
`/api/designer/my/orders/*/print`.

### Tests worth running

`npx jest src/modules/designer` (renderer, golden and NPP-parity specs,
print queue, retention, addons, settings, cart, templates, fonts cmap).
Real Chromium: `designer-render.real.spec.ts`,
`designer-render.real.golden.spec.ts`, `designer-render.pdf.real.spec.ts`
(skip with `DESIGNER_RENDER_REAL=0`). Real Postgres queue:
`DATABASE_URL=… npx jest designer-print-queue.db.spec`. Web:
`npx vitest run src/components/designer`.

### Operational notes

- Disk: ~14 MB per print PNG plus originals up to the upload cap; see the
  Namez projection in OPERATIONS.md §4. Back up `PRIVATE_STORAGE_DIR`.
- `grep -i "runs as root"` in the API log must be empty;
  `GET /api/admin/ops/status` → `print_queue` (alert when
  `oldest_pending_age_s > 900` or an instance stays paused > 5 min).
- Run the print worker on one instance until RAM for a second browser is
  measured (OPERATIONS.md §2).
