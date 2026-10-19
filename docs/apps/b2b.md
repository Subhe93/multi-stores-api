# B2B app (`b2b`) — company buyers, net prices, EU reverse charge

M2 (company buyers) + M2.5 (EU reverse charge with VIES, "Shopify model").
Lets a shopper buy **as a company**: company name, organisation number, VAT
number and buyer reference travel with the order, prices can be shown
without VAT, and — when switched on — a company with a valid EU VAT number
in another EU country pays **no VAT** (reverse charge).

---

## Part 1 — for merchants and support

### What it does

- A **Person / Company** switch on the storefront (cart page and cart
  drawer, `multi-stores-web/src/components/layout/BuyerTypeToggle.tsx`; the
  choice is kept in the `ms-buyer-type` cookie).
- In company mode prices and totals are shown **excl. VAT** with the VAT
  amount beside them ("319.20 excl. VAT + 25 %" instead of "399 incl.
  VAT"); the money charged is the same unless reverse charge applies.
- The checkout asks for company name, organisation number, VAT number
  (optional or required) and a buyer reference. They are stored on the
  order, the customer and the address, sent to Kustom as an
  `organization` purchase, shown in the order emails and on invoices.
- **Reverse charge** (optional, off by default): the VAT number is checked
  live against the EU VIES service; when the seller and buyer are in
  different EU countries and the number is valid, the order carries 0 %
  VAT, the invoice prints the legal reverse-charge text and both VAT
  numbers, and the sale appears in the **EC sales list** report.
- The merchant can grant a **manual exemption** to a customer: a
  reverse-charge exemption with a VAT number, or a full exemption ("don't
  collect tax").

### What changes in the dashboard

- `/creator/b2b` with tabs **Settings**, **Reverse charge**, **Exemptions**,
  **EC sales** (`app/creator/b2b/page.tsx`,
  `components/apps/B2bGeneralSettings.tsx`, `B2bReverseChargeSettings.tsx`,
  `B2bExemptionsList.tsx`, `CustomerTaxExemption.tsx`).
- Orders: company badge, `?buyer=company|person` filter, a company card and
  the net row on the order detail, VIES evidence on reverse-charge orders.

### When it is off (G0)

No toggle, no company fields, prices as today. The storefront payload has
no `apps.b2b`. The public VAT check answers `status: "disabled"` without
calling VIES. Orders placed as companies keep their snapshot; the EC sales
report stays readable (it is not app-gated, `taxes.controller.ts`).

### How to enable

Any store type may enable it (`requires_independent: false`). Admin makes it
available, creator enables it at `/creator/apps`, then configures
`/creator/b2b`. Reverse charge additionally needs a seller tax country in
the EU (store tax settings), and in practice the [invoices](./invoices.md)
app with a legal profile that has the seller VAT number (it is required on
reverse-charge invoices and is the default VIES requester).

### Settings (`StoreApp.settings`, validated by `src/modules/b2b/b2b-settings.ts`)

Every key is optional on write; unknown keys are ignored (stored, never read).

| Key | Meaning | Default | Valid values | Public |
|---|---|---|---|---|
| `allow_company` | Shoppers may switch to company (false hides the toggle) | `true` | boolean | yes |
| `default_buyer_type` | Starting mode for a visitor without the cookie | `PERSON` | `PERSON` \| `COMPANY` | yes |
| `require_vat_number` | A company order must carry a VAT number | `false` | boolean | yes |
| `org_number_countries` | Countries whose organisation-number format is checked strictly (rules exist for SE, FI, DK, NO in `org-number.util.ts`); others use a generic rule | `["SE"]` | list of ISO2 codes | yes |
| `reverse_charge_enabled` | Remove VAT for VIES-valid cross-border EU companies | `false` | boolean | yes |
| `reverse_charge_pricing` | What a reverse-charge company pays on an INCLUSIVE (gross-priced) store: `net` = price minus the seller-country VAT; `gross` = unchanged price treated as net with 0 % VAT (Shopify behaviour). EXCLUSIVE stores ignore it | `net` | `net` \| `gross` | yes (always filled while reverse charge is on) |
| `vies_requester_vat` | VAT number sent to VIES as the requester (yields a consultation number); null = the seller VAT number of the invoices legal profile | `null` | a format-valid EU VAT number with prefix, `""` or null | **no** |

The reverse-charge decision (`reverse-charge.ts` `decideTaxExemption`), in
order: app/setting off → no exemption; marketplace store (platform is the
registrant) → none (`MARKETPLACE`); FULL customer exemption → 0 %; buyer is
a person → none; seller not in the EU, no destination yet, destination not in
the EU, or same country → none; manual REVERSE_CHARGE exemption with a VAT
number → 0 %; otherwise the VIES result must be **valid** and the VAT
number's country must not be the seller's. Anything else keeps the VAT
(fail-closed: VIES down = VAT charged, `VAT_UNAVAILABLE`).

### Worked example — Namez

Swedish seller, INCLUSIVE prices, `tax_country SE`:

```json
PUT /api/stores/my/apps/b2b
{ "enabled": true,
  "settings": { "allow_company": true, "default_buyer_type": "PERSON",
                "require_vat_number": false, "org_number_countries": ["SE"],
                "reverse_charge_enabled": true, "reverse_charge_pricing": "net" } }
```

- A Swedish company on namez.se: 399 kr incl. VAT is shown as 319.20 kr +
  25 % VAT; it pays 399 kr (same country, no reverse charge).
- A German company with a VIES-valid `DE…` number on namez.shop: the quote
  drops the Swedish VAT; with `net` a 199 kr item costs 159.20 kr (€17.99
  → €14.39), the invoice shows 0 % with the reverse-charge text (art. 138 /
  10 kap. 42 § ML) and both VAT numbers, and the order is listed in the EC
  sales report (PROGRESS.md M2.5 live test).
- With `gross` the German company pays the full 199 kr, booked as net.

### Limits and known gaps

- **Decision still open for Namez** (M5-PLAN B7): whether to switch reverse
  charge on for EU companies on the `eu` market is the client's/accountant's
  call. With it off, an EU company pays Swedish VAT 25 %.
- A **FULL** customer exemption also requires `reverse_charge_enabled`: the
  decision returns "app off" before it looks at the exemption
  (`decideTaxExemption`). Not obvious from the dashboard wording — check
  with the merchant before relying on FULL exemptions with reverse charge
  off.
- Reverse charge never applies on marketplace stores (`MARKETPLACE`).
- The M2.5 web/dashboard review flagged that Kustom might not apply the
  exemption when the company name or number is missing (PROGRESS.md M2.5,
  marked fixed). The guard on the order path: a buyer who saw a VAT-free
  quote sends `expect_reverse_charge`, and when the server cannot confirm
  it the order is refused with `409 B2B_REVERSE_CHARGE_NOT_CONFIRMED`
  instead of silently charging VAT (`orders/dto/order.dto.ts`). The Kustom
  playground was not configured locally, so the Kustom side is not
  live-tested (PROGRESS.md 2.8).
- Greece uses `EL` in VIES and `GR` as ISO country; numbers are normalised
  with the VIES prefix (`VatNumberCheck.vat_number`).
- Deferred payment "invoice, pay in 30 days" for companies is not built
  (PLAN.md decision 4): companies pay at checkout.
- Partial-refund tax distribution should be reviewed with the client's
  accountant (PROGRESS.md M3 operational notes).
- Seeded email templates: stores created before M2 need
  `prisma/scripts/seed-store-email-templates.ts --only-missing` to show the
  company block (DEPLOY-M4.md §6).

---

## Part 2 — for developers and operators

### Files

`src/modules/b2b/`: `b2b-settings.ts` (lenient parse + strict validation +
public projection), `b2b.service.ts`, `b2b.types.ts` (mirror of
`multi-stores-shared/src/types/b2b.ts`), `org-number.util.ts`,
`vat-number.util.ts`, `reverse-charge.ts` (pure decision),
`b2b-tax-exemption.service.ts` (`prepare` / `decide` / `checkVat` /
exemptions), `vies/` (`vies.service.ts` cache + queue, `vies.client.ts`,
`vies.mock.ts`, `vies.parse.ts`), controllers `b2b-storefront.controller.ts`
and `b2b-exemptions.controller.ts`. Tax engine hook: `computeTaxes`
(`display_mode`, `net_*`) in `src/modules/taxes/`; EC sales:
`src/modules/taxes/ec-sales-report.ts`. Web: `lib/b2bSettings.ts`,
`lib/buyerType.ts`, `components/layout/BuyerTypeToggle.tsx`, checkout
company block. Dashboard: `app/creator/b2b/page.tsx`, `components/apps/B2b*`.

### Data model (migrations `20261016120000_add_b2b`, `20261018120000_add_reverse_charge`, `20261018130000_vat_check_mode`)

| Table | Columns |
|---|---|
| `Customer` (+) | `customer_type` (`BuyerType`), `company_name`, `org_number`, `vat_number` |
| `Address` (+) | `company_name`, `org_number`, `buyer_reference` |
| `Order` (+) | `customer_type`, `company_name`, `org_number`, `vat_number`, `buyer_reference`, `tax_exempt_reason` (`REVERSE_CHARGE`/`CUSTOMER_EXEMPT`), `vat_validation` JSON (`VatEvidence`) |
| `KustomCheckoutSession` (+) | `buyer_type`, `company` JSON, `vat_validation` |
| `Invoice` (+) | `tax_exempt_reason`, `buyer_vat_number`, `buyer_country` |
| `VatNumberCheck` | every VIES consultation: `vat_number`, `country_code`, `status` (`VALID`/`INVALID`/`UNAVAILABLE`), `error_code`, `name`, `address`, `request_identifier`, `requester`, `request_date`, `checked_at`, `store_id` (no FK), `source` (storefront/quote/order/kustom/dashboard), `mode` (live/mock) |
| `StoreCustomerTaxExemption` | `store_id`, `customer_id`, `kind` (`REVERSE_CHARGE`/`FULL`), `vat_number`, `note` (private), `created_by`, `revoked_at/by`; at most one active row per (store, customer) via the partial unique index `StoreCustomerTaxExemption_active` |

`VatNumberCheck` rows are evidence and are **kept forever**
(DATA-MODEL-CONVENTIONS.md). The customer-facing projection of
`Order.vat_validation` drops ids, requester, address and notes
(`customerVatEvidence`).

### API routes

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /api/storefront/:slug/b2b/vat-check` `{vat_number, country_code?}` | public, 20/min/IP, not app-gated | VIES check + reverse-charge verdict for a destination; `status: disabled` when off |
| `GET /api/b2b/my/tax-exemptions?include_revoked=` | CREATOR + `@RequireApp('b2b')` | list exemptions |
| `GET /api/b2b/my/tax-exemptions/by-customer/:customerId` | same | one customer's exemptions |
| `POST /api/b2b/my/tax-exemptions/vat-check` `{vat_number}` | same | dashboard VIES lookup (with address and consultation number) |
| `POST /api/b2b/my/tax-exemptions` `{customer_id? \| order_id?, kind, vat_number?, note?}` | same | grant |
| `DELETE /api/b2b/my/tax-exemptions/:id` | same | revoke |
| `GET /api/taxes/my/reports/ec-sales?from=&to=&format=csv` | CREATOR, not app-gated | EC sales list (periodisk sammanställning) |
| `GET /api/orders?buyer=company\|person` | CREATOR | filter |

Settings are written through `PUT /api/stores/my/apps/b2b`. Cart, quote,
Kustom session and order responses carry a `b2b` block (`display_mode`,
`net_items`, `net_shipping`, `net_total`) and a `tax_exemption` block only
when the app is on.

Error codes: `B2B_COMPANY_NOT_ALLOWED`, `B2B_COMPANY_NAME_REQUIRED`,
`B2B_ORG_NUMBER_REQUIRED`, `B2B_ORG_NUMBER_INVALID`,
`B2B_VAT_NUMBER_REQUIRED`, `B2B_VAT_NUMBER_INVALID`,
`B2B_REVERSE_CHARGE_NOT_CONFIRMED` (409), `B2B_EXEMPTION_*`.

### Env (VIES)

| Variable | Default | Notes |
|---|---|---|
| `VIES_MODE` | `live` | `mock` (tests / dev; mock rows never serve live) or `off` (every check `unavailable`, i.e. VAT charged) |
| `VIES_BASE_URL` | EC endpoint | |
| `VIES_TIMEOUT_MS` | 4000 | |
| `VIES_CACHE_TTL_HOURS` | 24 | answers are cached per VAT number |
| `VIES_QUEUE_TIMEOUT_MS` | 2000 | dedup / queue wait |

### Events / jobs

None. Kustom callbacks re-run the decision from stored evidence without
calling VIES (`reverse-charge.ts` header comment).

### Tests worth running

`npx jest src/modules/b2b` (settings, reverse charge, exemption service,
org/VAT number utils, VIES service/parse, public throttle);
`src/modules/invoices/invoices.reverse-charge.spec.ts`. Live VIES test
(network): `VIES_LIVE_TEST=1 npx jest src/modules/b2b/vies/vies.live.spec.ts`.

### Operational notes

- VIES outages fail closed (VAT charged); watch for `VAT_UNAVAILABLE`
  complaints rather than for errors.
- Keep the EC sales export with the bookkeeping; the source rows
  (`Order.tax_exempt_reason`, `Invoice.buyer_vat_number`) are immutable on
  invoices.
