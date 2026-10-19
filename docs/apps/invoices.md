# Invoices app (`invoices`) — gapless numbering, immutable PDF invoices, credit notes

M3 (+ reverse-charge lines from M2.5). Issues a legal **invoice** for every
paid order and a **credit note** for every cancellation or refund, numbered
in a gapless series per store, rendered as a PDF in the order's language and
currency, attached to the order email and downloadable by the customer and
the merchant.

---

## Part 1 — for merchants and support

### What it does

- **Automatic issue**: when Stripe confirms the payment or Kustom
  authorises it; for cash on delivery either when the order is created or
  when it is marked delivered (setting). Manual issue and "issue all
  backlog" exist for older orders.
- **Gapless numbers** per store: optional prefix (e.g. `NZ-`), a
  configurable **start number** (to continue a previous system's sequence),
  zero-padding; a **separate series for credit notes** (default prefix `CN-`).
- **Immutable**: an issued invoice cannot be edited or deleted (a database
  trigger refuses it); corrections are credit notes.
- **Credit notes**: full on cancellation (setting), on full refund, on a
  released Kustom authorisation (always), pro-rata on partial refunds, or
  manual (any amount up to what is left).
- **PDF** in the order's locale (6 languages incl. Arabic RTL) and currency,
  with the seller's legal block (org number, VAT number, F-skatt, bank
  details, logo), the company buyer block from [b2b](./b2b.md), and 0 % lines
  with the legal text for reverse-charge orders.
- **Email**: order emails get the invoice numbers, a link and the seller
  block as template variables, and the not-yet-emailed PDFs as attachments.

### What the shopper sees when it is on

- An **Invoices** section on the order page of their account
  (`multi-stores-web/src/components/account/OrderInvoices.tsx`,
  `app/store/[storeSlug]/account/orders/[id]/page.tsx`) with PDF downloads.
- The PDF attached to the order emails.

### What changes in the dashboard

`/creator/invoices` with tabs **Invoices** (list, filters, CSV export),
**Backlog** (paid orders without an invoice, "issue all"), **Profile** (seller
legal profile), **Numbering**, **Settings** (`app/creator/invoices/page.tsx`,
`components/invoices/*`, `components/apps/InvoicesSettingsCard.tsx`). The
order detail gets an invoice card with "issue now" and "credit note"
(`components/invoices/OrderInvoiceCard.tsx`).

### When it is off (G0)

Nothing is issued and order emails render exactly as before (the extension
adds empty strings; templates guard with `{{#if}}`). Already issued
documents stay **readable**: the list, detail, customer documents and PDF
routes are not app-gated; issuing, numbering, the legal-profile write and
credit notes are (`invoices-creator.controller.ts`).

### How to enable

1. Store must be **INDEPENDENT**.
2. Admin makes the app available; creator enables it.
3. Fill the **legal profile**. Issuing refuses with
   `INVOICE_PROFILE_INCOMPLETE` until it has `legal_name`, `org_number`,
   `address_line1`, `postal_code`, `city`, `country_code`, one bank account
   (IBAN, bankgiro or plusgiro) and — when the document carries VAT or is a
   reverse-charge invoice — `vat_number` (`legal-profile.util.ts`
   `profileCompleteness`).
4. Set the numbering **before the first invoice** (the start number locks
   after the first issue: `INVOICE_SEQUENCE_LOCKED`).
5. Use **Backlog → issue all** for paid orders placed before enabling.

### Settings (`StoreApp.settings`, validated by `src/modules/invoices/invoice-settings.ts`)

Unknown keys are **refused**.

| Key | Meaning | Default | Valid values |
|---|---|---|---|
| `auto_issue` | Issue automatically on payment / COD trigger | `true` | boolean |
| `cod_issue_on` | When a cash-on-delivery order gets its invoice | `delivered` | `created` \| `delivered` |
| `attach_pdf_to_email` | Attach the PDF to order emails | `true` | boolean |
| `credit_on_cancel` | Credit the invoice in full when the order is cancelled | `true` | boolean |

A released Kustom authorisation is **always** credited in full, whatever
`credit_on_cancel` says (`invoice-triggers.service.ts`).

### Numbering (`PUT /api/invoices/my/numbering`, `dto/numbering.dto.ts`)

Per series (`invoice`, `credit_note`):

| Field | Meaning | Valid values |
|---|---|---|
| `prefix` | Text before the number; may change any time (copied onto each document) | empty, or ≤ 12 chars of letters, digits, `. _ / -`, **ending in a non-digit** |
| `next_number` | Next number; only while nothing was issued in that series | 1 – 999 999 999 |
| `padding` | Zero-pad to this many digits | 0 – 10 |

Initial values: invoice prefix `""`, credit-note prefix `CN-`, padding 0,
start 1 (`legal-profile.service.ts`).

### Legal profile (`PUT /api/invoices/my/legal-profile`, `dto/legal-profile.dto.ts`)

All fields optional, `null`/`''` clears: `legal_name`, `brand_name`,
`org_number`, `vat_number`, `address_line1/2`, `postal_code`, `city`,
`country_code` (ISO2), `registered_office` ("Säte"), `email`, `phone`,
`website`, `bankgiro`, `plusgiro`, `iban` (mod-97), `bic`, `bank_name`,
`logo_url` (**must be an `/uploads/…` path** — remote logos are not
fetched), `f_tax_approved` (default false), `due_days` (0–120, default 30),
`footer_note` (≤ 1000), `timezone` (IANA, default `Europe/Stockholm`; it
dates the invoices and is also used by the production digest). Format
errors: `INVOICE_IBAN_INVALID`, `INVOICE_BANKGIRO_INVALID`,
`INVOICE_BIC_INVALID`, `INVOICE_VAT_NUMBER_INVALID`,
`INVOICE_TIMEZONE_INVALID`.

### Worked example — Namez

```json
PUT /api/invoices/my/numbering
{ "invoice": { "prefix": "NZ-", "next_number": 1001, "padding": 0 },
  "credit_note": { "prefix": "CN-", "next_number": 1 } }
```

First invoice `NZ-1001`, then `NZ-1002` …; credit notes `CN-1`, `CN-2` …
(PROGRESS.md M3 live test). Settings: `auto_issue: true`, `cod_issue_on:
"delivered"`, `attach_pdf_to_email: true`, `credit_on_cancel: true`. An EUR
order on namez.shop gets an English PDF in EUR; a reverse-charge company
order gets a 0 % line and the seller + buyer VAT numbers.

### Limits and known gaps

- **One legal profile per store** (`key = 'default'`); no per-market legal
  entity (`Market.legal_entity_id` is reserved).
- No deferred-payment ("pay within 30 days") invoices for companies; the
  invoice is issued for money already paid (PLAN.md decision 4). `due_days`
  only prints a due date.
- PDF rendering needs a Chromium on the API host; without it
  (`INVOICE_PDF_ENGINE=off` or no browser) the PDF route answers `503
  INVOICE_PDF_UNAVAILABLE` and emails go **without** the attachment (the
  invoice itself is still issued and numbered).
- Rendering inside the order flow is bounded by `INVOICE_EMAIL_PDF_BUDGET_MS`
  (8 s); a slow PDF is left out of that email (PROGRESS.md M3 note: COD order
  creation was ~11 s locally with a failing SMTP).
- Partial-refund VAT split should be checked with the client's accountant.
- `Invoice` rows survive store deletion and cannot be deleted at all (by
  design, legal retention).
- Schema comment drift: `StoreLegalProfile.logo_url` says "/uploads/... or
  https", but the DTO accepts only `/uploads/` paths (the DTO wins).

---

## Part 2 — for developers and operators

### Files

`src/modules/invoices/`: `invoices.service.ts` (issue, credit, backlog,
list/CSV, read access), `invoice-numbering.service.ts` (`FOR UPDATE` lock +
consume), `invoice-triggers.service.ts` (hooks called by orders / payments /
Kustom; never throws), `invoice-snapshot.builder.ts` (immutable snapshot),
`legal-profile.service.ts` + `legal-profile.util.ts`, `invoice-settings.ts`,
`invoices-mail.extension.ts`, `invoices-csv.ts`, `pdf/` (`chromium.renderer.ts`,
`invoice-template.ts`, `invoice-phrases.ts` ×6 languages, `fonts.ts` Noto
OFL fonts from npm, `invoice-pdf.service.ts`), `storage/invoice-storage.ts`
(atomic local disk), controllers `invoices-creator`, `invoices-documents`,
`invoices-admin`. DB guard: `prisma/sql/invoice-guards.sql`.

### Data model (migration `20261017120000_add_invoices`, + `20261018120000_add_reverse_charge`)

| Table | Notes |
|---|---|
| `StoreLegalProfile` | one `default` row per store; columns as in the profile table above |
| `InvoiceSequence` | one row per (profile, kind): `prefix`, `padding`, `start_number` (audit), `next_number`, `issued_count`, `last_issued_at` |
| `Invoice` | `kind` (`INVOICE`/`CREDIT_NOTE`), `sequence_number`, `number`, `credited_invoice_id`, `trigger` (`PAYMENT`, `COD_CREATED`, `COD_DELIVERED`, `MANUAL`, `REFUND`, `CANCELLATION`), `idempotency_key`, `issue_date`, `due_date`, `currency`, `locale`, signed `net_total`/`vat_total`/`gross_total`, `paid`, buyer fields, `tax_exempt_reason`, `buyer_vat_number`, `buyer_country`, `snapshot` JSON + `snapshot_version` + `snapshot_sha256`; mutable bookkeeping only: `pdf_path`, `pdf_sha256`, `pdf_generated_at`, `emailed_at` |

Uniques: `(legal_profile_id, kind, sequence_number)`, `(store_id, kind,
number)`, `(store_id, idempotency_key)`. `store_id` and `legal_profile_id`
have no FK on purpose (survive store deletion; DATA-MODEL-CONVENTIONS.md).
`order_id` is `ON DELETE RESTRICT`. The trigger rejects DELETE / TRUNCATE
and any UPDATE outside the PDF/email columns.

Numbering is gapless because the number is taken under `SELECT … FOR UPDATE`
in the same transaction that inserts the document; a rollback rolls the
counter back. An inconsistent snapshot is refused before a number is
consumed (`INVOICE_SNAPSHOT_INVALID`).

### API routes

Creator (`CREATOR`, prefix `/api/invoices/my`; `@RequireApp('invoices')` on the writes):

| Method + path | Gated | Purpose |
|---|---|---|
| `GET legal-profile` | no | profile + completeness + numbering view (`locked` per series) |
| `PUT legal-profile` | yes | save profile |
| `PUT numbering` | yes | prefix / next_number / padding |
| `GET /` `?kind&from&to&q&paid&page&limit&format=csv` | no | list or CSV (≤ 10 000 rows) |
| `GET backlog?limit=` | yes | orders without an invoice (paid, or COD + delivered; not cancelled/refunded) |
| `POST backlog/issue` | yes | issue up to 500 backlog orders |
| `POST orders/:orderId/issue` | yes | manual issue (`INVOICE_ALREADY_ISSUED` 409 on repeat) |
| `GET :id` | no | detail with timeline |
| `POST :id/credit-note` `{amount?, reason?}` | yes | manual credit (omitted amount = all that is left; `INVOICE_CREDIT_EXCEEDS`, `INVOICE_CREDIT_NOTHING_LEFT`) |

Customer / creator (`AuthGuard('jwt')`, ownership checked, 404 otherwise):
`GET /api/invoices/documents/orders/:orderId`, `GET
/api/invoices/documents/:id/pdf` (30/min). Admin: `GET /api/invoices/admin`.

### Triggers (no queue)

`InvoiceTriggersService`: `onOrderPaid` (Stripe succeeded / Kustom
authorized), `onCodOrderCreated`, `onStatusChanged` (DELIVERED → COD issue;
CANCELLED → credit when `credit_on_cancel`; REFUNDED → full credit),
`onFullRefund`, `onPartialRefund(cumulative)` (idempotency key
`refund:<order>:<cumulative minor>`), `onCancelled`,
`onAuthorizationReleased`. Each is idempotent and logs instead of throwing.

### Env

| Variable | Default | Notes |
|---|---|---|
| `INVOICE_PDF_ENGINE` | `chromium` | `off` → 503 `INVOICE_PDF_UNAVAILABLE` |
| `INVOICE_PDF_CHROMIUM_PATH`, `INVOICE_PDF_BROWSER_CHANNEL` | – | legacy; win over `CHROMIUM_PATH` / `CHROMIUM_CHANNEL` |
| `INVOICE_STORAGE_DIR` | `<cwd>/storage/invoices` | back it up |
| `INVOICE_EMAIL_PDF_BUDGET_MS` | 8000 | per email |

### Tests worth running

`npx jest src/modules/invoices` (numbering, snapshot builder, triggers,
mail extension, CSV, PDF template, reverse charge). Real Postgres
(gaplessness, trigger): `INVOICE_E2E_DATABASE_URL=… npm run test:e2e --
invoices` (creates and drops its own schema, `test/invoices.e2e-spec.ts`).
PDF smoke with a real browser: `INVOICE_PDF_SMOKE=1` (`pdf/chromium.renderer.spec.ts`).

### Operational notes

- Install `chromium-headless-shell` (or a system Chromium) for the API user;
  the same browser serves the designer (OPERATIONS.md §1 "Browser").
- Include `INVOICE_STORAGE_DIR` in backups (OPERATIONS.md §5). PDFs can
  always be re-rendered from the snapshot, but the stored file and its
  `pdf_sha256` are the evidence of what was sent.
- Stores created before M3 need `seed-store-email-templates.ts
  --only-missing` for the invoice variables in their templates.
