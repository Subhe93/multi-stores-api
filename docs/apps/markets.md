# Markets app (`markets`) — several domains, currencies and languages for one store

M1. One store, one catalog, several **markets**. A market is a set of
countries with its own hostname(s), currency, default language and price
rule. Built for Namez: `namez.se` (Sweden, SEK, Swedish) and `namez.shop`
(euro area, EUR, English) selling the same products.

---

## Part 1 — for merchants and support

### What it does

- Each market has its **own domain** (e.g. `namez.shop`), its **own
  currency** and a **default language** served without a URL prefix; other
  languages of the market are served under `/xx/` (e.g. `namez.shop/sv/…`).
- Prices in a market are either **converted** from the store's base prices
  (manual rate or the platform FX table, with rounding such as `.99`), or
  **set by hand** per product / variant in the product's "Prices by market"
  tab. A product can also be **hidden** in one market.
- Orders remember the market, hostname, language and the rate used. Emails,
  password-reset links and Kustom/Stripe sessions use the market's domain and
  currency; the invoice PDF uses the order's language and currency.
- Before a market can go **LIVE**, the platform checks that Stripe or
  Kustom can actually charge its currency and shows what is missing.

### What the shopper sees when it is on

- The market's domain shows prices in the market currency and the market's
  default language.
- A **country switcher** and a **language switcher** in the header
  (`multi-stores-web/src/components/layout/CountrySwitcher.tsx`,
  `LanguageSwitcher.tsx`).
- A **"you seem to be in …" banner** suggesting the right market (from geo /
  Accept-Language); it never redirects, and dismissing it sets the
  `ms-market-suggest-dismissed` cookie for 365 days
  (`components/layout/MarketSuggestBanner.tsx`).
- Moving to another market's domain carries the cart over and re-prices it.
- The checkout country list on a non-default market is exactly the market's
  countries.
- SEO: `hreflang` alternates (`lang-REGION`) across the market domains,
  canonical on the current domain, a sitemap per domain.

### What changes in the dashboard

- New page **Markets** (`/creator/markets`, `/creator/markets/new`,
  `/creator/markets/[id]`): countries, languages, currency, price rule,
  domains with DNS instructions and a Verify button, payment check card.
- Product editor: **Prices by market** tab
  (`components/markets/ProductMarketPricesTab.tsx`).
- Orders list: market badge and `?market=<key>` filter; reports per currency;
  order detail amounts in `order.currency`.
- Store settings: the custom-domain field and the languages card are taken
  over by Markets ("managed by Markets" hint in
  `app/creator/store/page.tsx`); the API refuses `custom_domain` edits with
  `STORE_CUSTOM_DOMAIN_MANAGED_BY_MARKETS` while the app is on.
- Admin: FX rates card and domain status card
  (`components/markets/AdminFxRatesCard.tsx`, `AdminStoreDomainsCard.tsx`).

### When it is off (G0)

Every market hook receives `null` and runs the pre-markets path
(`market-context.ts`). The storefront is served only on the platform
subdomain and the store's legacy `custom_domain`; prices are the base
prices in the store currency. While the app is off the default market
mirrors the store's language settings (`mirrorLanguagesIntoDefault`).

**Careful:** switching the app off takes every *non-default* market domain
offline at once — `GET /stores/by-domain/:host` then only honours the legacy
`custom_domain` (`stores.service.ts` `lookupCustomDomain`). Existing orders
keep their currency columns, but market-aware re-pricing (`byId`) returns
`null` while the app is off; what that means for an open EUR order that is
re-quoted or refunded was **not verified** for this doc.

### How to enable

1. The store must be **INDEPENDENT** (`requires_independent: true`).
2. Admin makes the app available; creator enables it at `/creator/apps`.
3. Enabling creates the **default market** from the store (key `default`,
   store currency, primary locale, always LIVE, no countries; it is served on
   the platform subdomain and on any domains you attach to it).
4. Create the other markets, attach domains, run the payment check, set LIVE.

The app has **no `StoreApp.settings`**; everything lives in the `Market`,
`StoreDomain` and `ProductMarketPrice` tables.

### Market fields (validated by `src/modules/markets/dto/market.dto.ts` and `markets.service.ts` `normalize`)

| Field | Meaning | Valid values |
|---|---|---|
| `key` | URL/API handle | 1–16 lower-case letters, digits, hyphens, no leading/trailing hyphen; unique per store; the default market's key is locked (`MARKET_DEFAULT_LOCKED`) |
| `name` | Display name | 1–80 chars |
| `countries` | ISO2 countries of the market | up to 250, upper-cased; a country may belong to **one LIVE market only** (`MARKET_COUNTRY_OVERLAP`) |
| `default_locale` | Language served without prefix | one of `en ar tr de fr sv` (`MARKET_LOCALE_UNSUPPORTED`) |
| `locales` | Extra languages (served under `/xx/`) | up to 10, same list; must not contain `default_locale` (`MARKET_DEFAULT_LOCALE_IN_LOCALES`) |
| `currency` | ISO 4217 | must be supported by the platform (`MARKET_CURRENCY_UNSUPPORTED`) |
| `price_rule.mode` | `convert` (base × rate) or `fixed` (only manual prices; products without an override fall back to conversion when a rate exists, else are hidden) | `convert` \| `fixed` |
| `price_rule.source` | where the rate comes from | `manual` \| `platform` (`PlatformFxRate`, admin-maintained) |
| `price_rule.rate` | manual rate | number > 0 when `convert` + `manual` (`MARKET_FX_RATE_MISSING`) |
| `price_rule.rounding.increment` | round to a multiple of this | number ≥ 0 (e.g. 1, 0.5) |
| `price_rule.rounding.ending` | price ending | `none` `.99` `.90` `.95` `9` `0` |
| `status` | `DRAFT` or `LIVE` | the default market is always LIVE |

Going **LIVE** (`PUT /markets/:id/status`) requires: no country overlap, an
ACTIVE non-redirecting hostname (`MARKET_PRIMARY_DOMAIN_REQUIRED`), a usable
rate (`MARKET_FX_RATE_MISSING`) and a payment check where Stripe **or**
Kustom is `ok` (`MARKET_PAYMENT_CHECK_FAILED`). Changing the currency of a
LIVE market re-runs the check and is refused when it fails.

**Domains**: `POST /markets/:id/domains {hostname, redirect_to?}` →
PENDING; the creator's **Verify** reads DNS (CNAME to
`CUSTOM_DOMAIN_CNAME_TARGET` or A to `CUSTOM_DOMAIN_A_TARGET`) → VERIFIED;
an **admin** sets ACTIVE after nginx/TLS are in place. Only ACTIVE hosts are
served. `redirect_to` makes a host 301 to another host (www → apex).

### Worked example — Namez (from `plans/namez-store-apps/NAMEZ-SHOP-MARKET-SETUP.md`)

Default market: SEK, `sv`, domain `namez.se` (+ `www.namez.se` with
`redirect_to: namez.se`). Second market:

```json
POST /api/markets
{
  "key": "eu",
  "name": "Europe",
  "countries": ["DE","FI","AT","NL","BE","FR","ES","IT","IE","PT","LU","GR","SK","SI","EE","LV","LT","HR","CY","MT"],
  "default_locale": "en",
  "locales": ["sv","ar"],
  "currency": "EUR",
  "price_rule": { "mode": "convert", "source": "manual", "rate": 0.087, "rounding": { "ending": ".99" } }
}
```

- Euro-area countries only (Kustom charges DK/PL/CZ/… in their own
  currency). **DE first**: the Kustom-first checkout uses the first country
  as the default purchase country. SE is not listed (it belongs to the
  default market).
- Add `namez.shop` (primary) and `www.namez.shop` (`redirect_to:
  namez.shop`), point DNS at the platform, Verify, admin sets ACTIVE.
- `POST /markets/<id>/payment-check`, then `PUT /markets/<id>/status
  {"status":"LIVE"}`.
- Manual EUR prices (and compare-at) per product/variant in "Prices by
  market" or `PUT /markets/products/:productId/prices`.

### Limits and known gaps

- **Shipping costs and free-shipping thresholds are entered in the store's
  base currency** (SEK for Namez) and converted with the market rate in the
  checkout, the order and Kustom alike; there is no per-zone or per-market
  shipping price. With a manual rate you pick SEK values that convert to
  round EUR amounts (NAMEZ-SHOP-MARKET-SETUP §4: 113.79 SEK → €9.90 at
  0.087). `POST /shipping/estimate` converts only when the storefront sends
  `store_id` + `market_key` (`shipping.controller.ts`).
- **`x-default` is fixed to the default market** in its default locale
  (`multi-stores-web/src/lib/storeUrl.spec.ts`: "x-default is the default
  market in its default locale"); it cannot point at another market.
- **Kustom-first billing country**: the session sends `shipping_countries`
  = the market's countries but no `billing_countries`, so the billing
  country stays the purchase country (shopper's country if known, else the
  first market country). Test a non-DE billing address in the Kustom
  playground before going live; otherwise keep the order-first flow
  (NAMEZ-SHOP-MARKET-SETUP §6).
- The Kustom currency check uses a **static country→currency table**
  (Kustom has no API for it); `ok` means "should work", the merchant must
  confirm EUR is enabled on their merchant id.
- Platform FX rates are maintained by an admin (`PUT /markets/admin/fx-rates`);
  there is no automatic fetch job.
- One legal entity for all markets (`Market.legal_entity_id` is reserved,
  unused). Per-market media, per-market staff and DKK/NOK markets are later
  work (M5-PLAN M5.8).
- Tax: one tax setup per store. EU B2C buyers on the `eu` market pay the
  store's (Swedish) VAT unless OSS + destination rates are configured
  (NAMEZ-SHOP-MARKET-SETUP §5). B2B reverse charge is the [b2b](./b2b.md) app.
- The Verify button may fail behind a proxied Cloudflare record (the CDN
  hides the CNAME); the admin activates the host after checking it
  (PROGRESS.md, UX notes).

---

## Part 2 — for developers and operators

### Files

- API module `src/modules/markets/`: `markets.service.ts` (CRUD, default
  market, product prices), `markets-context.service.ts` (cached per-store
  context, 60 s TTL), `market-context.ts` (the `MarketContext` passed to every
  hook), `market-pricing.service.ts` + `pricing.util.ts` (conversion,
  rounding, overrides), `fx.service.ts`, `domains.service.ts` (DNS verify),
  `payment-check.service.ts` (Stripe account/capabilities + Kustom table),
  `market.types.ts` (mirror of `multi-stores-shared/src/types/market.ts`).
- Consumers: `stores.service.ts` (`lookupCustomDomain`, custom-domain guard,
  language mirroring), `shipping.controller.ts` (estimate), orders / cart /
  Kustom / Stripe / mail (market currency, hostname, locale), `auth.service.ts`
  (reset links on the market host).
- Web: `src/proxy.ts` (host → market, `x-market*` headers, stripped from
  incoming requests), `src/lib/market-routing.ts` (pure routing decision:
  default locale, 301 for a redundant prefix, 404 for a locale the market
  does not serve), `src/lib/market.ts`, `src/lib/storeUrl.ts` + `locale-path.ts`
  (hreflang/canonical), sitemaps under `src/app/**/sitemap.xml/route.ts`.
- Dashboard: `app/creator/markets/**`, `components/markets/*`.

### Data model (migration `20261015120000_add_markets`, `20261015130000_fix_default_market_currency`)

| Table | Key columns |
|---|---|
| `Market` | `store_id`, `key` (varchar 16, unique per store), `name`, `countries[]`, `default_locale`, `locales[]`, `currency`, `is_default`, `status` (`DRAFT`/`LIVE`), `price_rule` JSON `{mode, source, rate?, rounding:{increment?, ending?}}`, `payment_check` JSON `{stripe, kustom, checked_at, details}`, `legal_entity_id` (reserved) |
| `StoreDomain` | `hostname` (unique, lower-case), `market_id`, `is_primary`, `redirect_to`, `status` (`PENDING`/`VERIFIED`/`ACTIVE`), `verified_at`, `last_observed` |
| `ProductMarketPrice` | `market_id`, `product_id`, `variant_id?`, `price?`, `compare_at_price?` (market currency; null = auto), `available` (product-level row only); unique `(market_id, product_id, variant_id)` + partial unique index for `variant_id IS NULL` |
| `PlatformFxRate` | `base`, `quote`, `rate` Decimal(18,8) |
| `Order` (+) | `market_id`, `hostname`, `locale`, `fx_rate_snapshot` (all nullable) |
| `KustomCheckoutSession` (+) | `market_id`, `hostname` |

The migration backfilled a `StoreDomain` row for every existing
`custom_domain`; with the app off such a row is honoured only while it still
equals the legacy column.

### API routes

Creator (`AuthGuard('jwt')`, `CREATOR`, `@RequireApp('markets')`, prefix `/api/markets`):

| Method + path | Purpose |
|---|---|
| `GET /markets` | list with domains, effective rate, payment check, `platform_hostname` |
| `POST /markets` | create (DRAFT) |
| `GET /markets/dns-target` | CNAME / A target (null until the platform sets one) |
| `GET /markets/fx-preview?from=&to=` | platform rate preview |
| `GET /markets/products/:productId/prices` | auto price / override per market and variant |
| `PUT /markets/products/:productId/prices` | `{markets:[{market_id, available?, price?, compare_at_price?, variants?:[{variant_id, price?}]}]}` |
| `GET /markets/:id`, `PUT /markets/:id`, `DELETE /markets/:id` | read / update / delete (default market undeletable: `MARKET_DEFAULT_UNDELETABLE`) |
| `PUT /markets/:id/status` | `{status: DRAFT \| LIVE}` |
| `POST /markets/:id/payment-check` | re-run the provider check |
| `POST /markets/:id/domains`, `DELETE /markets/:id/domains/:domainId` | add / remove a host |
| `POST /markets/:id/domains/:domainId/verify` | DNS check → VERIFIED |
| `PUT /markets/:id/domains/:domainId/primary` | mark canonical host |

Admin (`ADMIN`, prefix `/api/markets/admin`): `GET/PUT fx-rates`,
`DELETE fx-rates/:base/:quote`, `GET stores/by-creator/:creatorId/domains`,
`PUT domains/:id/status` (`{status}`; the only way to ACTIVE).

Public: `GET /api/stores/by-domain/:host` (60/min/IP; `market` + `markets`
only with the app on), `GET /api/stores/:slug/market-context` (120/min; not
app-gated, answers `{enabled:false}` when off; used by the proxy for
platform subdomains and fails open). `GET /api/payments/config?market=`,
`POST /api/shipping/estimate` with `store_id` + `market_key`, and
`POST /orders/quote` carry market info.

### Events / jobs

None of its own. Every mutation drops the markets context cache and
revalidates the storefront (`afterMutation`). The context cache is
per-instance with a 60 s TTL (`markets-context.service.ts`); it is not
included in the `pg_notify` channel, so another instance can serve a stale
market for up to 60 s after an edit.

### Env

`CUSTOM_DOMAIN_CNAME_TARGET`, `CUSTOM_DOMAIN_A_TARGET`,
`CUSTOM_DOMAIN_DNS_TIMEOUT_MS` (default 5000) — `domains.service.ts`.
`CORS_ALLOWED_ORIGINS` need not list market hosts: ACTIVE hosts are picked up
automatically (NAMEZ-SHOP-MARKET-SETUP §3.5). nginx must forward the `Host`
header to the web app (the proxy resolves the market from it) and hold a
certificate for each host.

### Tests worth running

`npx jest src/modules/markets` (pricing util, market pricing, FX, domains,
markets context, payment check), `src/modules/shipping/shipping.market-estimate.spec.ts`;
web: `npx vitest run src/lib/storeUrl.spec.ts` plus the market-routing specs
under `src/lib/`.

### Operational notes

- Domain activation is a manual admin step after DNS + nginx + TLS.
- A missing platform FX row no longer takes the store down: the market is
  listed with `rate: null` and only checkout fails with
  `MARKET_FX_RATE_MISSING` (`listLive` / `safeContext`).
- Doc mismatch to be aware of: NAMEZ-SHOP-MARKET-SETUP.md calls the default
  market `se`; in code the default market's key is always `default`
  (`DEFAULT_MARKET_KEY` in `markets.service.ts`) and cannot be renamed.
