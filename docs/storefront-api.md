# Storefront API (public, read-only): contract for external sites

Audience: a developer building a custom website (for example `example.se`) that shows a ShopsDoor store's catalogue (courses, dates, prices, seats) and sends visitors to the ShopsDoor store (for example `shop.example.se`) to book and pay.

This file is the single source for that work. The contract is enforced by `src/modules/storefront/storefront.public-contract.spec.ts`; change both together.

Status markers: **LIVE** = deployed behaviour. **PLANNED (Pn)** = agreed in `plans/headless-booking/PLAN.md`, not built yet; do not depend on it before the phase is deployed.

---

## 1. Base, auth, envelope, errors

- Base URL: `https://<api-host>/api` (all routes below are under the global prefix `/api`). The production API host is given to you by the platform owner; keep it in an env var (`SHOPSDOOR_API_URL`).
- Store identifier: the store **slug** (`:slug`), for example `example`. It never changes after the store is created.
- Auth: none. These routes are public. Do **not** send `Authorization: Bearer ...`: on these routes a bearer is read as an owner/admin "viewer" (owner preview of a non-LIVE store). An anonymous request always sees the public view.
- Method: `GET` only. No request body.
- Success envelope (every route):

```json
{ "success": true, "data": <payload>, "timestamp": "2026-11-15T10:00:00.000Z" }
```

  Always read `data`. The examples below show `data` only.
- Error envelope:

```json
{ "success": false, "statusCode": 404, "code": "STOREFRONT_STORE_NOT_FOUND", "message": "Store not found" }
```

  Branch on `statusCode` and `code`, never on `message` (English, may change). Codes you can meet: `STOREFRONT_STORE_NOT_FOUND` (unknown or suspended store, 404), `STOREFRONT_PRODUCT_NOT_FOUND` (404), `MARKET_NOT_FOUND` / `MARKET_NOT_LIVE` (only when you pass `?market=`; do not).
- Dates are ISO 8601 strings in UTC. Money values are JSON numbers in major units (`4500` = 4 500 SEK, `199.5` = 199.50).

## 2. Public gate (store not LIVE)

Only a store with `status: "LIVE"` serves its catalogue. While the store is being set up (DRAFT, PENDING_REVIEW, CHANGES_REQUESTED) or PAUSED:

| Route | Answer |
|---|---|
| `GET /storefront/:slug` | 200 with a small "closed shell": `{ slug, name, logo_url, status, coming_soon, paused, is_active: false, indexing: "noindex", language_config, theme... }` and no catalogue keys |
| `GET /storefront/:slug/products` | 200 `[]` |
| `GET /storefront/:slug/products/:productSlug` | 404 `STOREFRONT_STORE_NOT_FOUND` |
| `GET /storefront/:slug/creator-categories` | 200 `[]` |
| `GET /storefront/:slug/sitemap-data` | 200 with empty lists |

SUSPENDED and unknown slugs: 404 on every route.

Consequence for a custom site built before go-live: a staging build sees an empty catalogue until the store is LIVE. Treat `[]` as "no courses right now", and **fail the build** (do not publish an empty site) when the store payload has `coming_soon` or `paused` set to `true`.

## 3. Routes

### 3.1 `GET /storefront/:slug`: store

Query: none needed (`market` and `preview` are internal, do not send them).

Documented keys (LIVE store):

| Key | Type | Meaning |
|---|---|---|
| `id` | string (uuid) | Store id |
| `slug` | string | Store slug |
| `name` | string | Store name |
| `description` | string or null | Store description |
| `logo_url`, `favicon_url` | string or null | Media URL (see section 6) |
| `custom_domain` | string or null | The store's own host (for example `shop.example.se`); booking links go there |
| `status` | `"LIVE"` | Lifecycle state (other values only in the closed shell) |
| `is_active` | boolean | `true` when LIVE |
| `store_type` | `"INDEPENDENT"` or `"MARKETPLACE"` | A store that sells for itself is INDEPENDENT |
| `currency` | string (ISO 4217) | Currency of every price (for example `"SEK"`) |
| `language_config` | object | `{ primary_locale, secondary_locales[], fallback_locale, auto_translate, ... }` |
| `tax` | object | `{ pricing_mode: "INCLUSIVE" or "EXCLUSIVE", display_prices_incl_tax: boolean, country: "SE", registrant: "STORE" or "PLATFORM" }` (section 5) |
| `seller_details` | object or null | Legal trader identity (company name, org number, address, support email) |
| `card_payments_enabled`, `kustom_enabled` | boolean | Payment methods available on the store |
| `apps` | object | Enabled store apps by key (`{}` when none) |
| `tracking` | object | Public analytics ids of the store (`ga4_measurement_id`, `meta_pixel_id`, `tiktok_pixel_id`, `clarity_project_id`, `consent_required`). These belong to the store host; the custom site uses its own |
| `pages` | array | Published pages `{ slug, sort_order, translations: [{ locale, title }] }` |
| `cookie_page_slug` | string or null | Slug of the store's cookie page |
| `theme_key`, `theme_customizations`, `theme` | various | Store design data; ignore on a custom site |

Other keys may appear (for example `trader_details`, `went_live_at`, `created_at`, `creator`, `checkout` when the store overrides checkout defaults). Ignore keys you do not use.

**Never in this payload** (removed 2026-11, task D3; the contract spec fails if they come back): `notification_email`, `status_reason`, `golive_requested_at`, `stripe_key_lock_until`, `cache_enabled`, `oss_registered`, `shipping_tax_class_id`, `checkout_settings` (raw), `meta_capi_token`, `meta_test_event_code`. The store owner reads them through the owner endpoints (`/stores/my/store`, `/taxes/my/settings`, `/mail/store/notifications`), and the web reads the cache switch through `/storefront/:slug/cache-config`.

The older public route `GET /stores/:slug` (not used by the web or the dashboard) drops the same columns plus the Meta token and test code (`publicStoreRow`, list `PRIVATE_STORE_KEYS` in `src/modules/stores/store-secrets.ts`; spec `stores.capi-token.spec.ts`). External sites should read `GET /storefront/:slug`.

Trimmed example (shape from the code; values illustrative):

```json
{
  "id": "6f1c...", "slug": "example", "name": "Example Trafikskola",
  "description": null, "logo_url": "/uploads/stores/example/logo.webp", "favicon_url": null,
  "custom_domain": "shop.example.se", "status": "LIVE", "is_active": true,
  "store_type": "INDEPENDENT", "currency": "SEK",
  "language_config": { "primary_locale": "sv", "secondary_locales": ["en"], "fallback_locale": "en", "auto_translate": false },
  "tax": { "pricing_mode": "INCLUSIVE", "display_prices_incl_tax": true, "country": "SE", "registrant": "STORE" },
  "seller_details": { "legal_name": "Example Trafikskola AB", "org_number": "556...", "city": "...", "support_email": "..." },
  "card_payments_enabled": false, "kustom_enabled": true, "apps": {},
  "pages": [{ "slug": "villkor", "sort_order": 0, "translations": [{ "locale": "sv", "title": "Villkor" }] }],
  "cookie_page_slug": null
}
```

### 3.2 `GET /storefront/:slug/products`: product (course date) list

Query parameters:

| Param | Meaning |
|---|---|
| `creator_category=<collection slug>` | Only products in that collection (use one collection per course type, for example `riskettan`). Unknown or internal collections return `[]` |
| `search=<text>` | Case-insensitive match on any translation title |
| `category_id=<uuid>` | Platform taxonomy (not the store's collections); not needed |
| `page`, `limit` | **Accepted and ignored**: the list is **not paginated**; you get every PUBLISHED product of the store (or of the collection) in one array |

Order: newest product first (`created_at desc`). A MANUAL collection filtered with `creator_category` is returned in the owner's drag order. Sort course dates yourself (see section 7).

Payload: a plain JSON array. Each own product item:

| Key | Type | Meaning |
|---|---|---|
| `id` | string (uuid) | Product id |
| `status` | `"PUBLISHED"` | Only published products are listed |
| `product_type` | string | `TRADITIONAL` for courses |
| `base_price` | number | Price in `currency` (section 5) |
| `compare_at_price` | number (optional) | "Before" price; key absent when not set |
| `sku` | string or null | Owner's SKU |
| `track_inventory` | boolean | Whether stock is counted (section 4) |
| `stock_quantity` | number or null | Remaining seats of a product **without variants** |
| `is_featured` | boolean | Owner's highlight flag |
| `variant_option_config` | object or null | Option labels/swatches (ignore for courses) |
| `translations` | array | `{ locale, title, description (HTML), slug, short_description, meta_title, meta_desc }` per locale |
| `images` | array | **First image only** in the list: `{ url, alt_text, sort_order, is_featured, ... }` |
| `variants` | array | Active variants: `{ id, options: { <name>: <value> }, sku, price, compare_at_price?, stock, stock_quantity, ... }` |
| `category` | object or null | Platform category |
| `promotions` | array | Active automatic promotions that apply: `{ id, type, value, translations }` |
| `brand` | string (optional) | Only when set |
| `created_at`, `updated_at` | string | ISO dates |
| `max_per_order` | number or null | **LIVE**: maximum quantity of this product in one order; null = no limit. Additive key |

Product-level columns that are never served: `cost_price`, `external_ref`, `gtin`, `mpn`, `google_product_category`, `condition`, `feed_excluded`; variant `external_ref`.

Size: the list carries every product with its translations (HTML descriptions included). Fetch it once per build/revalidation, not per page view, and filter by collection when possible.

Trimmed example item:

```json
{
  "id": "a3b1...", "status": "PUBLISHED", "product_type": "TRADITIONAL",
  "base_price": 4500, "track_inventory": true, "stock_quantity": 3,
  "translations": [{ "locale": "sv", "title": "Riskettan 2026-12-01 17:00", "slug": "riskettan-2026-12-01", "description": "<p>...</p>", "short_description": null }],
  "images": [{ "url": "/uploads/products/risk1.webp", "alt_text": null, "sort_order": 0, "is_featured": true }],
  "variants": [], "promotions": [],
  "created_at": "2026-11-01T10:00:00.000Z", "updated_at": "2026-11-02T10:00:00.000Z"
}
```

### 3.3 `GET /storefront/:slug/products/:productSlug`: one product

`:productSlug` is any locale's `translations[].slug` (URL-encode it). Same core keys as the list item, plus: the full product gallery in `images` (product-level images, featured first), `variants[].images`, `custom_fields` (participant fields the booking page asks for), `faqs`, `attributes`, `creator_categories`, `primary_collection` keys, `shipping_profile`, `bundles`, and optional `videos` / `stories` (absent when empty). 404 `STOREFRONT_PRODUCT_NOT_FOUND` for an unknown or unpublished slug.

You normally do not need this route on the custom site: the list has everything for a course table. Use it for a course detail page if the site has one.

### 3.4 `GET /storefront/:slug/creator-categories`: collections

The store's active PUBLIC collections as a tree: `[{ id, slug, parent_id, thumbnail_url, sort_order, path: ["parent", "child"], translations: [{ locale, name, description, long_description, meta_title, meta_desc }], children: [...] }]`. Use `slug` as the `creator_category` filter of 3.2. Rule and importer internals (`match_rule`, `match_tags`, `external_ref`, `creator_id`) are never served.

### 3.5 Other public routes you may use

| Route | Use |
|---|---|
| `GET /storefront/:slug/sitemap-data` | Product slugs + `lastmod`, collections, pages, locales (for redirect maps or your own sitemap) |
| `GET /storefront/:slug/legal` and `/storefront/:slug/legal/:slug?locale=sv` | The store's legal pages (terms, privacy, refund, shipping). Link to them on the store host rather than copying them |
| `GET /storefront/:slug/cache-config` | `{ enabled: boolean }`: whether the store wants caching (section 8) |

Everything else under `/storefront/:slug/...` (menus, v2 page snapshots, templates) is internal to the ShopsDoor storefront; do not depend on it.

## 4. Seats (stock) rules

A course date is **one product**; its stock is the number of seats.

- Product **without variants**: seats left = `stock_quantity` when `track_inventory` is `true`. `stock_quantity` null = unlimited. Sold out when `track_inventory && stock_quantity <= 0`.
- Product **with variants** (for example a language option): each `variants[].stock` is that variant's seats; an untracked variant is served as `stock: 999`. The product is sold out only when **every** variant has `stock <= 0`.
- This is the same rule the store uses (`multi-stores-web/src/lib/productAvailability.ts`) and the rule checkout enforces. Show "N platser kvar" from these numbers and "Fullbokat" when sold out.

**Seat holds by unpaid orders.** Stock is taken when an order is created, before payment. An order that is never paid gives its seats back after **2 hours** (card / Stripe orders) or **6 hours** (Kustom orders created first). The release runs when the next order is placed on the platform (no scheduler), so an unpaid hold can last a little longer than that on a quiet day. With the Kustom session flow (the store creates the order only when Kustom validates the purchase) no seat is held while the visitor is still filling in the Klarna form. Consequence: the count you show can be briefly lower than the real free seats, never higher; overbooking is refused at checkout.

## 5. Prices and tax

- All prices are in the store payload's `currency` (one currency per store; never convert).
- Own product price: `base_price`. A variant's price: `variants[].price` (= `base_price` + the variant's adjustment). Show the variant price when a visitor chooses a variant, otherwise `base_price`; "from" = the lowest active variant price.
- Tax: with `tax.pricing_mode = "INCLUSIVE"` every price **includes** VAT; show it as is ("inkl. moms"). With `"EXCLUSIVE"` the prices exclude VAT and `tax.display_prices_incl_tax` tells the store how it displays them; the exact tax is computed at checkout from the buyer's address. Courses are usually VAT exempt or 25 %; do not compute VAT yourself.
- `compare_at_price` (when present and higher) is a "before" price; `promotions[]` are automatic discounts the store applies at checkout. Showing them is optional.

## 6. Media URLs

`images[].url`, `logo_url` and similar are either absolute (`https://...`, files on object storage) or **relative to the API origin** (`/uploads/products/x.webp`). Resolve a relative URL against the API origin (the base URL without `/api`), exactly like the store does:

```ts
const resolveMedia = (u?: string | null) =>
  !u ? '' : /^https?:\/\//.test(u) ? u : `${API_ORIGIN}${u}`;
```

If you use `next/image`, allow the API host and the object-storage host in `images.remotePatterns`.

## 7. Course date convention (optional, per store)

One product per course date. The Swedish title carries the date in the fixed format `YYYY-MM-DD HH:mm` (Europe/Stockholm local time), for example `Riskettan 2026-12-01 17:00`. Parse it from the `sv` translation title with `/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/`; hide products whose date is in the past; group by collection (`creator_category`). A title without a parsable date is a non-dated product (show it without a date, do not crash).

## 8. Caching and freshness

- The API sends no `Cache-Control`; caching is the caller's job.
- Recommended on the custom site: server-side fetch with ISR/revalidate **60 s** for course lists; a seat count that must be fresher can be read through your own small server route cached about 15 s. Never cache a non-2xx answer.
- The ShopsDoor store itself caches pages per store; a store with caching switched off (`cache-config` answers `{ "enabled": false }`) always renders fresh seats on the booking pages.
- There is no push notification of seat changes today (webhooks are a possible later phase, P5).

## 9. Rate limits and CORS

- The storefront routes are not throttled per IP (they are read by the store's own server). Be a good citizen anyway: at build time fetch with limited concurrency (2 to 4 parallel requests), retry on 429/5xx with backoff, and do not poll.
- **Call the API server-side** (Next.js server components, route handlers, build step). Browser calls from another site are not part of this contract: in production CORS allows only the platform's own hosts (`CORS_ALLOWED_ORIGINS`) and the stores' own domains, so a browser `fetch` from `example.se` is rejected. Server-side calls send no `Origin` and are not affected by CORS.
- An optional per-store API key (`X-Storefront-Token`) and allowed-origins list are **PLANNED (P2, optional)**; until then no key is needed.

## 10. Linking into the booking store

- Product page on the store: `https://<store custom_domain>/products/<slug>` where `<slug>` is the product's primary-locale `translations[].slug`, for example `https://shop.example.se/products/riskettan-2026-12-01`.
- Without a custom domain the store lives on the platform host under the store slug; use `custom_domain` from 3.1 when it is set.
- `?qty=N` pre-selects N seats on the product page; see 10.1.
- `?back=<path>` tells a focused storefront which page of the custom site the buyer came from; see 10.2.
- Do not put personal data in links (no names, emails, personnummer).

### 10.1 Pre-selecting seats: `?qty=N`

**LIVE.** A store page that cannot apply the parameter ignores it (quantity stays 1).

Format: append `qty` to the product link from section 10.

```
https://shop.example.se/products/riskettan-2026-12-01?qty=2
https://shop.example.se/products/riskettan-2026-12-01?qty=2&utm_source=example.se
```

Rules (applied in the shopper's browser on the product page):

| `qty` value | Quantity shown |
|---|---|
| missing | 1 (unchanged behaviour) |
| integer N, 1 or more, within the limits | N |
| integer above the limit | the limit (clamped) |
| `0`, negative, decimal (`2.5`), text (`abc`), empty | ignored, quantity stays 1 |

- **Limit** = the smallest of the seats left (`stock_quantity` when `track_inventory` is true; for a product with variants, the selected variant's stock) and `max_per_order` (section 3.2; null = no limit). A product that sells in fixed steps rounds the limit down to a whole step.
- A sold-out product shows as sold out; `qty` does not change that.
- The value only pre-fills the quantity selector. It **never adds to the cart** by itself and does not skip the participant fields; the shopper still presses "Boka".
- The page renders with quantity 1 on the server and applies `qty` right after load, so cached pages are shared between links with different `qty` values.
- The limits are enforced again by the API at cart add, at checkout and at payment (`CART_MAX_PER_ORDER`, `ORDER_INSUFFICIENT_STOCK`), so a hand-edited link cannot book more seats than allowed.
- Compute `qty` from the seats the visitor chose on the custom site; do not pass seats left from a cached build as `qty` (the store clamps anyway).

### 10.2 Back to the page the buyer came from: `?back=<path>`

**Not deployed yet** (storefront only; no API change). Only a focused storefront (11.5) reads it; every other store ignores the parameter.

A buyer who leaves the store without buying should land on the page of the custom site he came from, not on its home page. The buy link says which page that is:

```
https://shop.example.se/products/testlektion-60-min?back=%2Fproduct%2Ftestlektion-60-min%2F
https://shop.example.se/products/testlektion-60-min?qty=1&back=%2Fproduct%2Ftestlektion-60-min%2F
```

Format: `back` is the **path** of the page on the custom site (with its query and fragment when needed), URL-encoded once (`encodeURIComponent(location.pathname + location.search)`). It is never a full URL: the store always joins it to the origin of the stored `external_site_url`, so the host cannot be changed through the link.

The value is accepted only when all of this holds; anything else is ignored (the back links then lead to `external_site_url`):

| Rule | Refused examples |
|---|---|
| starts with exactly one `/` | `product/x`, `https://example.se/x`, `//evil.com` |
| no `//` anywhere, no backslash | `/a//b`, `/\evil`, `/a?u=//x` |
| no whitespace or control character, raw or percent-encoded (`%00`-`%1F`, `%7F`), no encoded backslash (`%5C`), no encoded slash right after the first one (`/%2F...`) | `/a b`, `/a%0Ab`, `/%2F%2Fevil.com` |
| at most 300 characters after decoding | |

Accepted examples: `/product/testlektion-60-min/`, `/kurser/b-korkort`, `/ok/path/?a=b#c`.

Behaviour:

- The store remembers the value for the browser tab (session storage). On every product page a valid `back` replaces the remembered one; a product link without `back` keeps it.
- The header logo, the "back to site" links, the cart's "continue shopping" link and the empty-cart link lead to `<external site origin><back>`. Without a remembered value they lead to `external_site_url` as before.
- The page is rendered with `external_site_url` in those links and switches to the remembered page right after load (same reason as `qty`: cached pages are shared between links).
- The return after a completed purchase (`return_url`, section 11) is not affected.
- Do not put personal data in the path.

## 11. Order return: back to the custom site after payment

**LIVE.** For every store that does not set it, checkout behaves exactly as before.

### 11.1 Flow

1. The visitor books on the store host (for example `shop.example.se`) and pays with Kustom (Klarna) or Stripe.
2. The payment provider always returns to the **store's own confirmation page** first (Kustom `merchant_urls.confirmation` and the Stripe `return_url` are unchanged). That page shows the Kustom snippet / receipt and fires the purchase tags.
3. Only when the order is in a final good state (Kustom: `paid`; Stripe: payment succeeded, inline card, or cash on delivery, never "processing" or "failed") the page shows a **"Tillbaka till <site>"** button. In `auto` mode an 8 second countdown with a "Stay on this page" button precedes the redirect, and the redirect waits up to 3 s for the purchase tags.
4. The visitor lands on the configured return URL, for example `https://example.se/tack?order=ORD-MB3K9X1-7QZP`.

### 11.2 Store settings (owner dashboard: Settings, Checkout behaviour, External website)

Stored in `checkout_settings` (owner endpoint `PUT /stores/my/store`):

| Key | Meaning |
|---|---|
| `external_site_url` | The custom site, for example `https://example.se`. Required for everything below. Setting or replacing it asks for the owner's password (plus the 2FA code when 2FA is on). |
| `return_url` | Optional page after payment on the same site. May contain `{order_number}`, nothing else. Empty = `external_site_url`. |
| `return_mode` | `button` (default) or `auto`. |
| `back_label` | Optional button text per locale (`{ "sv": "Tillbaka till Example" }`); default "Tillbaka till <host>". |
| `external_focus` | Optional boolean, default off: the **focused storefront** (11.5). Accepted as `true` only with an `external_site_url` (stored, or sent in the same body); cleared together with the site. No password prompt of its own. |

URL rules, checked when saved, again when read, and again in the browser before rendering:

- `https://` only, default port only, no `user:password@`, a real domain name (no IP address, no `localhost`).
- The `return_url` host must be **exactly** the `external_site_url` host or its `www.` twin (`example.se` <-> `www.example.se`). Subdomains (`shop.example.se`) and look-alikes are refused; there is no "same registrable domain" rule.
- `{order_number}` may appear in the path, query or fragment, never in the host. It is replaced with the URL-encoded order number. No other value is ever added: no email, name, personnummer, order uuid, session or token, and no totals.
- The `external_site_url` host must be a site of its own: not the platform, not a store subdomain of the platform, and not one of the hosts that serve the same store (its custom domain or market domains, including the `www.` twin). Refused with reason `store_host_not_allowed`.
- A refused value returns `400 CHECKOUT_EXTERNAL_URL_NOT_ALLOWED` with `field` (`external_site_url`, `return_url` or `external_focus`) and `reason` (`invalid_url`, `too_long`, `https_required`, `userinfo_not_allowed`, `port_not_allowed`, `host_not_allowed`, `placeholder_not_allowed`, `external_site_url_required`, `store_host_not_allowed`).
- Every change to either URL (including clearing it) and every switch of `external_focus` writes the security log row `checkout.external_return.updated` and emails the owner. The changed fields are named `external_site_url`, `return_url`, `external_focus`, with ` (cleared)` appended when a URL is emptied or the focused storefront is turned off.

With an external site set, the checkout logo, the checkout footer link and the "continue shopping" links (empty cart, cart page, receipt) also lead to `external_site_url` (with `rel="noreferrer"`).

### 11.3 What the custom site must do on the return page (`/tack`)

- Read `order` from the query only to **show** it ("Ditt bokningsnummer: ORD-..."). Order numbers are not sequential; treat them as opaque strings.
- There is **no API to look an order up by number**, and none is planned. Show static text; the order details are in the confirmation email.
- Remove the number from the address bar and from analytics (see 11.4) before any tag reads `page_location`.
- Do not fire a purchase / conversion event on `/tack`: the store's confirmation page already did.
- Expect visitors who never reach `/tack` (button mode, closed tab): it is a convenience, not a confirmation channel.

### 11.4 Consent and tracking checklist (two hosts)

- [ ] **Consent is per host.** The store uses a host-only `consent_<slug>` cookie; the custom site needs its own banner (Consent Mode v2). Two banners in v1 are expected; shared consent across subdomains is not supported.
- [ ] **GA4**: the same measurement ID on both hosts is fine. With consent, `_ga` is set on `.example.se` by both, so no cross-domain linker is needed. Add `kustom.co`, `klarna.com`, `stripe.com` and `checkout.stripe.com` to **unwanted referrals** so the return from the payment provider does not start a new session.
- [ ] **Purchase only on the store confirmation page.** Never send `purchase` (GA4), `Purchase` (Meta) or `CompletePayment` (TikTok) from `/tack`. Meta deduplicates on `purchase_<order uuid>`, which the custom site never sees.
- [ ] **No order number in analytics.** On `/tack`, strip the query from `page_location` (or call `history.replaceState` to `/tack` after reading the number) before GA4 / GTM / Meta run.
- [ ] **Referrer**: both apps send `Referrer-Policy: strict-origin-when-cross-origin` and the return links carry `rel="noreferrer"`, so the store path is not leaked to the custom site.
- [ ] **Clarity**: the store masks the checkout and does not record the confirmation pages; recordings are not stitched across the two hosts.
- [ ] **Cookie / privacy page** of the custom site names the vendors used on both hosts (and links to the store's cookie page).
- [ ] **CSP** of the custom site allows GA / GTM / Meta only after consent; no `frame-ancestors` change is needed (the store is never framed).

### 11.5 Focused storefront (`external_focus`)

**Not deployed yet** (API, storefront and dashboard change together; see the deploy note of the release). Opt-in, default off; needs an `external_site_url`. Owner dashboard: Settings, Checkout behaviour, External website, "Focused storefront".

With it on, the store host is a purchase step of the custom site, not a second shop. The buyer arrives on a product page (section 10), fills the fields, adds to the cart, pays, and returns (11.1). On every host of the store:

- **Header**: the store logo (links to `external_site_url`), a "back to site" link (`back_label` for the locale, else "Back to <host>") and the cart with its count. No menu, collections, search, country or language switcher, account link or announcement bar, whichever header the store uses (built-in or a published builder header). Under it, on the product, cart and checkout pages, a step indicator: 1 Your details, 2 Cart, 3 Payment. The logo and the back link follow `?back=<path>` (10.2).
- **Footer**: a dark brand band (derived from the store's primary colour) with the logo, the seller's contact block (address, phone, e-mail from the seller details), one links column, the "back to site" link, the legal line (legal name, organisation number, platform line) and the cookie settings link. No collection columns, no newsletter.
- **Footer links**: the store's navigation menu with key `footer` when it exists and has items (absolute URLs are rendered as given, so the links can be the custom site's own terms, privacy, FAQ and contact pages; relative ones are store links). Only without such a menu the store's own `/legal/*` pages are listed. The cookie page link stays in both cases. The checkout's own terms link is not affected.
- **Redirected to `external_site_url`** (HTTP 307, temporary): the store home page, `/collections` and every collection page, the `/products` listing, and content pages at `/<page-slug>`. A locale prefix (`/en/...`) changes nothing.
- **Never redirected**: product pages (`/products/<slug>`), `/cart`, the checkout and the order confirmation pages, `/account/*`, `/auth/*`, `/legal/*`, the cookie page and any content page that serves a legal slug (privacy, terms, refund, shipping), `robots.txt`, `sitemap.xml`, API and static routes, the builder preview, the owner's preview, and the "coming soon" / "temporarily closed" page of a store that is not LIVE.
- **Product page**: presented as step 1 of the purchase: collection name, title and short description, a summary card (main image, price with the tax note, seller phone), one card with the buyer's fields (two columns on desktop), the options, the quantity (only when more than one unit can be bought) and the add-to-cart button, and the long description, specifications and FAQ behind a closed "More information" section. Same data, rules and add-to-cart as the regular product page; no breadcrumb, collection link or product listing sections, so there is no in-page path into a listing. Designer products keep the regular product page.
- **After "add to cart"** the buyer goes to the cart page (several products can go into one order), unless the store chose `after_add_to_cart: "checkout"`. "Continue shopping" and the empty cart lead to `external_site_url` (as in 11.2).
- **`sitemap.xml`** lists product pages only. Indexing rules are otherwise unchanged.

What the custom site should do: link to product pages (never to the store home or a collection, they come straight back), add `?back=<path>` to those links (10.2), and expect visitors to arrive on `external_site_url` (or on that page) from the store's logo and back links without a referrer.

The public `checkout` block carries `"external_focus": true` only while it is on; a store with a site but without it serves exactly the block it served before.

## 12. D3 decision record (private store columns)

Before the seven columns were removed, `multi-stores-web/src` and `multi-stores-dashboard/src` were searched for each key, and the source endpoint of every reader was checked:

| Key | Readers found | Source endpoint | Public reader? |
|---|---|---|---|
| `notification_email` | dashboard `OrderNotificationsCard.tsx` | `/mail/store/notifications` | no |
| `status_reason`, `golive_requested_at` | dashboard `useStorefrontUrl.ts`, `StoreStatusCard.tsx`, `creator/store/page.tsx`, admin stores page | `/stores/my/store`, admin stores API | no |
| `stripe_key_lock_until` | none | - | no |
| `cache_enabled` | web `src/lib/api.ts`; dashboard `creator/settings/page.tsx` | `/storefront/:slug/cache-config`; `/stores/my/store` | no |
| `oss_registered`, `shipping_tax_class_id` | dashboard `taxRate.ts`, `creator/settings/page.tsx`, admin taxes page | `/taxes/my/settings`, `/taxes/admin/settings` | no |

The only dashboard reader of `GET /storefront/:slug` (`previewSampleProduct.ts` `loadPreviewStoreInfo`) reads `currency`, `apps` and `tax`; the web reads `seller_details ?? trader_details`. All seven keys were therefore removed; none was kept.

## 13. Stability policy

- Keys documented here are not removed or renamed without a new version of this file and notice to the custom-site owner.
- New keys may be **added** at any time (nullable or optional); clients must ignore unknown keys and treat a missing optional key as "not set".
- Keys listed as "never in this payload" stay out; `storefront.public-contract.spec.ts` enforces both lists.
- Additive keys documented so far: `max_per_order` on product list and detail (P1); inside the store `checkout` block, `external_site_url`, `return_url`, `return_mode`, `back_label` (P3, present only when the store sets an external site) and `external_focus` (focused storefront, 11.5: present, as `true`, only while it is on). `email_note` (P4) is never served by these routes.
