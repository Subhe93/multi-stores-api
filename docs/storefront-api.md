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
| `GET /storefront/:slug/products` | 200 `[]`; with `page` (3.2, not deployed yet): `{ "items": [], "total": 0, "page": <page>, "limit": <limit>, "has_more": false }` |
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
| `limit=<1..100>` | Live since 2026-11-18. Without `page`: at most that many products, still a **plain array**: the first N items of the list you get without `limit`, in the same order. Values above 100 count as 100; `0`, negative, decimal or non-numeric values are ignored (full list) |
| `page=<1..1000>` | Live since 2026-11-18. Switches to the paged answer below. Page size = `limit` (1 to 100), default 24. A page above 1000 counts as 1000; `0`, negative or non-numeric values count as page 1 |
| `sort` | Live since 2026-11-18. Only together with `limit` or `page` (ignored otherwise): `newest`, `price_asc`, `price_desc` or `name`. Any other value = the default order. `name` compares the title in the `locale` you pass (else the translation with the smallest locale code), case- and accent-insensitive with numbers in numeric order, empty titles last. `price_asc` / `price_desc` compare the **stored base amount** in the store currency: they ignore market prices, variant price differences ("from" prices), promotions and the tax display, so the order can differ from the prices shown (on a marketplace store, an imported product priced per variant or by margin is sorted by a stored amount that may be 0) |
| `card=1` | **Not deployed yet.** Opt-in data for a richer product card; works with the full list, `limit` and `page`. Only the exact value `1` counts, any other value is ignored. Each item then carries up to **2** `images` (same order, the first one is the image you get today), and an imported (provider) product also carries `variant_option_config` and `compare_at_price` (number, absent when none) with the values of its product page. Nothing else changes: no field is removed, the order of the items and the paged envelope are the same |

**Without `page`, `limit` and `card` nothing changes:** you get every PUBLISHED product of the store (or of the collection) in one plain array, as before. No value of `page`, `limit` or `sort` ever causes an error.

Order: newest product first (`created_at desc`). A MANUAL collection filtered with `creator_category` is returned in the owner's drag order. Sort course dates yourself (see section 7). Products created at the same instant: in the full list their relative order is not defined (and can change when one is edited); with `limit` or `page` they are ordered by `id`, so pages never repeat or skip a product while the catalogue does not change. `sort` overrides the drag order of a MANUAL collection.

Payload: a plain JSON array (also with `limit`). With `page` (**not deployed yet**) the payload is an object instead:

```json
{ "items": [ ... ], "total": 57, "page": 2, "limit": 24, "has_more": true }
```

`items` holds list items of the same shape as the array items; `total` is the number of products matching the same filters; `page` and `limit` are the values actually applied; `has_more` = `page * limit < total`. A page past the end returns `"items": []` with the true `total`.

**Shopper filters and facets (not deployed yet, opt-in).** Used by the storefront's filtered listing; any client may send them. Every parameter is optional and never causes an error; with none of them the answer is the one above, byte for byte.

| Param | Meaning |
|---|---|
| `collection=<slug>[,<slug>…]` | Products in any of these public collections (MANUAL links or the TAGS rule of each). Combines with `creator_category` (both must hold) |
| `type=<category slug>[,…]` | Platform category of the product (imported products: of the base product) |
| `color=<value>[,…]`, `size=<value>[,…]` | Variant option values. The colour option is the one styled as colours in the option config, else the option whose name contains colour / color / färg / farbe / couleur / renk / kleur / colore / لون; the size option is named size / storlek / größe / taille / beden / talla / maat / مقاس / قياس |
| `price_min`, `price_max` | Listed price (`base_price` of the item, market price included), inclusive, up to 2 decimals. A reversed range is swapped |
| `in_stock=1` | Only products that can be bought. With `color` / `size`: a variant of that colour and size that can be bought |
| `facets=1` | With `page`: the answer gains `facets` (below) |

Values are matched case-insensitively after trimming; commas and runs of spaces fold, so `Navy  Blue` and `navy blue` are one value. Several values of one parameter are OR, parameters are AND. Lists accept commas or repeated keys (at most 30 values of 80 characters each). The filters work in every mode (full list, `limit`, `page`); the order is the one of `sort` / the default order, with `price_asc` / `price_desc` comparing the listed price here (market price included). With `page`, `total` counts the filtered products.

`facets` (counts are disjunctive: each facet applies every other active filter, so a value shows what selecting it would add):

```json
{
  "collection": [{ "value": "new", "label": "New in", "count": 12, "parent": null }],
  "type": [{ "value": "t-shirts", "label": "T-shirts", "count": 8 }],
  "color": [{ "value": "black", "label": "Black", "count": 9, "swatch": "#111111" }],
  "size": [{ "value": "m", "label": "M", "count": 7 }],
  "price": { "min": 129, "max": 899 },
  "in_stock": { "count": 31 }
}
```

`collection` lists the store's active public collections that hold at least one product of the base list (labels in `locale`; `parent` = the parent's value), `type` only when the products span two or more categories, `color` with the seller's swatch colour(s) when set (`swatch2` for two-colour values), `size` in size order (XS…5XL, then numbers, then the rest). `price` is the range of the listed prices under the other filters (null when nothing matches). Values with count 0 are kept so a client can show them disabled.

Each own product item:

| Key | Type | Meaning |
|---|---|---|
| `id` | string (uuid) | Product id |
| `status` | `"PUBLISHED"` | Only published products are listed |
| `product_type` | string | `TRADITIONAL` for courses |
| `base_price` | number | Price in `currency` (section 5) |
| `compare_at_price` | number (optional) | "Before" price; key absent when not set |
| `sku` | string or null | Owner's SKU |
| `track_inventory` | boolean | Whether stock is counted (section 4) |
| `stock_quantity` | number or null | Remaining seats of a product **without variants**. With variants: the sum of the active variants' numbers when every one of them carries a number (**not deployed yet**; before that deploy the raw product number, which does not follow variant sales); the product's own number when any variant is untracked. Per-variant stock stays `variants[].stock` |
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
| `requires_shipping` | boolean | **Not deployed yet.** `false` = a service or digital product ("Physical product" switched off in the product form): the store's checkout has no shipping step for it and charges no shipping. Additive key; treat a missing key as `true` (section 3.6) |

Product-level columns that are never served: `cost_price`, `external_ref`, `gtin`, `mpn`, `google_product_category`, `condition`, `feed_excluded`; variant `external_ref`.

**Imported products** (`_type: "custom_product"`, MARKETPLACE stores only; a creator resells a supplier's product): `base_price` is the creator's selling price, never the supplier's price. **Not deployed yet:** they also carry `track_inventory` and `stock_quantity`, the supplier's stock of the product, shared by every store that resells it; same meaning as on an own product (section 4). Their `variants[].stock` already was the supplier's variant stock.

Size: the list carries every product with its translations (HTML descriptions included). Fetch it once per build/revalidation, not per page view, and filter by collection when possible. When you need only a few products, send `limit` (live since 2026-11-18).

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

`:productSlug` is any locale's `translations[].slug` (URL-encode it). Same core keys as the list item, plus: the full product gallery in `images` (product-level images, featured first), `variants[].images`, `custom_fields` (participant fields the booking page asks for), `faqs`, `attributes`, `creator_categories`, `primary_collection` keys, `shipping_profile` (always `null` for a product with `requires_shipping: false`: it has no shipping table and inherits no default profile), `bundles`, and optional `videos` / `stories` (absent when empty). 404 `STOREFRONT_PRODUCT_NOT_FOUND` for an unknown or unpublished slug.

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

### 3.6 Products that need no shipping (services, digital products)

**Not deployed yet.** A product with `requires_shipping: false` is sold without shipping, the way Shopify treats a product whose "Physical product" setting is off. The owner sets it per product; every product has `true` until the owner switches it off, so nothing changes for a store that does not use it.

One rule for every key below: **only the literal `false` means "no shipping"**. A missing key, `null` or `true` all mean "requires shipping", so a client written before the feature keeps working.

| Where | Key | When it is present |
|---|---|---|
| Product list and detail (3.2, 3.3), own products | `requires_shipping: boolean` | Always |
| Product detail of a resold (custom) product | `requires_shipping: false` | Only when `false` |
| `GET /cart`, each line | `requires_shipping: false` | Only when the line's product needs no shipping |
| `GET /cart`, top level | `requires_shipping: false` | Only when the cart has lines and none of them needs shipping |
| `POST /orders/quote`, each item | `requires_shipping: false` | Only when `false` |
| `POST /orders/quote`, top level | `requires_shipping: false` | Only when no line needs shipping |
| `POST /shipping/estimate`, `POST /shipping/countries` | `requires_shipping: false` | Only when none of the `product_ids` needs shipping |
| Order payloads (create response, `GET /orders/:id`, lists) | `requires_shipping: boolean` on the order and on each item | Always; the values are frozen when the order is placed |

Behaviour:

- **No line needs shipping**: there is no shipping step. The quote has `shipping_cost: 0`, `shipping_method_id: null` and, once a country is known, `shipping: { available: true, cost: 0, estimated_days: null, method: null, methods: [] }`. No country is ever "unavailable" and shipping zones are not consulted. A `shipping_method_id` sent with the quote or the order is ignored (never `ORDER_SHIPPING_METHOD_INVALID`). `/shipping/estimate` answers `{ available: true, methods: [], cost: 0, estimated_days: null, free_shipping: true, requires_shipping: false }` and `/shipping/countries` answers `{ restricted: false, countries: [], requires_shipping: false }`. The address the buyer gives is still required: it is the billing address, and tax is calculated from it.
- **Mixed cart** (at least one line needs shipping): the shipping step is shown as usual. Rates are calculated for the lines that need shipping only (their shipping profiles and their unit count); a free-shipping threshold still compares against the subtotal of the whole cart. A client may keep sending every product id to `/shipping/estimate`: the API leaves the no-shipping products out by itself.
- **After the order**: an order where nothing needed shipping is completed by the owner with "Mark as fulfilled" (stored status `DELIVERED`). The buyer then gets the "order complete" email (`order_fulfilled`) instead of the shipped / delivered emails.
- A venue-bound service that the buyer collects in person (an event with tickets handed out at the door) can instead stay a physical product with a pickup shipping method; then nothing above applies to it.

### 3.7 What a buyer's order payload carries

**Not deployed yet.** The order payloads a buyer receives (the `POST /orders` response, `GET /orders/my`, `GET /orders/:id` read as the buying customer) carry what a receipt needs and nothing about the sellers' money or the supplier's catalogue:

- No `commission` and no `payouts` on the order; no `provider_base_amount` on the items.
- `items[].product`: only `{ id, translations, images }`.
- `items[].variant`: only `{ id, options, images }`; its nested `product` only `{ id, translations, images }`.
- `items[].custom_product`: only `{ id, translations, mockup_images, product: { id, translations, images } }`.
- Every other order and item key is unchanged (`unit_price`, `original_unit_price`, `total_price`, `quantity`, `image_url`, `custom_field_values`, `variant_options_snapshot`, tax, shipping and fulfillment fields, ids).
- `timeline` carries no internal bookkeeping rows (`STOCK_RETURNED`, `STOCK_RETAKEN`, `TRANSFER_REVERSAL_DUE`, `TRANSFER_REVERSED`, `TRANSFER_REVERSAL_FAILED`); the store owner and admins see them.

### 3.8 Guest checkout: `POST /orders/guest`

**Not deployed yet.** A shopper without a session places an order in one public call. Nobody is signed in and no account email is sent. Rate limit 10 per minute.

- Body: `email` (required), `first_name?`, `last_name?`, `phone?`, `store_slug?` or `hostname?` (one is required, 400 `STORE_REQUIRED`), `locale?`, `turnstile_token?`, `address: { full_name, line1, line2?, city, state?, postal_code, country_code, phone?, company_name?, org_number?, buyer_reference? }`, `lines` (1 to 100, the shape `POST /orders/quote` takes), and the order fields `store_id`, `payment_method?`, `coupon_code?`, `notes?`, `shipping_method_id?`, `market_key?`, `buyer_type?`, `company?`, `expect_reverse_charge?`, `tracking?`. Unknown keys are refused (400).
- 201: `{ order, guest_token, guest_token_expires_at }`. `order` is the buyer payload of section 3.7 without the `customer` object. The answer has the same shape whether the email already had an account or not.
- Errors of its own: 400 `GUEST_ORDER_STORE_MISMATCH` (the store of `store_slug` / `hostname` is not `store_id`), 400 `GUEST_ORDER_NOT_ALLOWED` (the email belongs to a blocked account), 400 `AUTH_CAPTCHA_FAILED`. Every error of `POST /orders` passes through unchanged (line errors carry `line_index`).
- `guest_token` is good for 24 hours and only for that order: `GET /orders/guest/:id`, `POST /payments/guest/create-intent` and `POST /payments/guest/confirm` (body `{ order_id }`), each with `Authorization: Bearer <guest_token>`. They answer like `GET /orders/:id`, `POST /payments/create-intent` and `POST /payments/confirm` do for a signed-in customer. Any token problem, or another order id, is 401 `GUEST_TOKEN_INVALID`. The token is not a session: every other route refuses it.

The seller-side catalogue routes (`GET /products`, `GET /products/:id`, `GET /products/:id/variants`, `GET /variants/:id`) are not public: they need a signed-in provider, creator or admin (401 without a token, 403 for a customer account). A custom site reads products through the `/storefront/:slug/...` routes above only.

## 4. Seats (stock) rules

A course date is **one product**; its stock is the number of seats.

- Product **without variants**: seats left = `stock_quantity` when `track_inventory` is `true`. `stock_quantity` null = unlimited. Sold out when `track_inventory && stock_quantity <= 0`.
- Product **with variants** (for example a language option): each `variants[].stock` is that variant's seats; an untracked variant is served as `stock: 999`. The product is sold out only when **every** variant has `stock <= 0`.
- This is the same rule the store uses (`multi-stores-web/src/lib/productAvailability.ts`) and the rule checkout enforces. Show "N platser kvar" from these numbers and "Fullbokat" when sold out.
- Imported products (section 3.2) follow the same rules with the supplier's stock. Once the platform switches it on, checkout takes their stock from the supplier and refuses a short line with `ORDER_INSUFFICIENT_STOCK`, like an own product.

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
- **Not deployed yet:** the server cart also refuses a quantity above the stock. `POST /cart/items` and a quantity increase on `PUT /cart/items/:id` answer 400 `{ code: "CART_INSUFFICIENT_STOCK", message, available, product_id?, variant_id?, custom_product_id? }`; `available` is the largest quantity the line may hold (the stock minus the units of the same stock row on the cart's other lines, never below 0). A decrease is always accepted. `GET /cart` lines carry `stock_available` (same number) when their stock is counted, and no such key otherwise.
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
| `return_label` | Optional text, per locale (`{ "sv": "Till bokningsbekraftelsen" }`), of the "return to the website" button on the **paid confirmation page only**. Same shape and limits as `back_label` (20 locales, 60 characters). Empty = that button uses `back_label`, else the default. The header back link and "continue shopping" always use `back_label`. Kept only with an `external_site_url`, cleared together with it, no password prompt. |
| `external_focus` | Optional boolean, default off: the **focused storefront** (11.5). Accepted as `true` only with an `external_site_url` (stored, or sent in the same body); cleared together with the site. No password prompt of its own. |

URL rules, checked when saved, again when read, and again in the browser before rendering:

- `https://` only, default port only, no `user:password@`, a real domain name (no IP address, no `localhost`).
- The `return_url` host must be **exactly** the `external_site_url` host or its `www.` twin (`example.se` <-> `www.example.se`). Subdomains (`shop.example.se`) and look-alikes are refused; there is no "same registrable domain" rule.
- `{order_number}` may appear in the path, query or fragment, never in the host. It is replaced with the URL-encoded order number. No other value is ever added: no email, name, personnummer, order uuid, session or token, and no totals.
- The `external_site_url` host must be a site of its own: not the platform, not a store subdomain of the platform, and not one of the hosts that serve the same store (its custom domain or market domains, including the `www.` twin). Refused with reason `store_host_not_allowed`.
- A refused value returns `400 CHECKOUT_EXTERNAL_URL_NOT_ALLOWED` with `field` (`external_site_url`, `return_url` or `external_focus`) and `reason` (`invalid_url`, `too_long`, `https_required`, `userinfo_not_allowed`, `port_not_allowed`, `host_not_allowed`, `placeholder_not_allowed`, `external_site_url_required`, `store_host_not_allowed`).
- Every change to either URL (including clearing it) and every switch of `external_focus` writes the security log row `checkout.external_return.updated` and emails the owner. The changed fields are named `external_site_url`, `return_url`, `external_focus`, with ` (cleared)` appended when a URL is emptied or the focused storefront is turned off. A change of `return_label` is logged the same way (`return_label`, or `return_label (cleared)` when emptied) and, like the other keys of this table, can only be made by the owner.

**Store without customer accounts** (`no_customer_accounts`, same settings card, not tied to the external site): an optional boolean, default off, that any store can use. While it is on, the buyer's account is still created at the first order and the order is still linked to it (customer data is stored exactly as before; sign-in and "forgot password" keep working), but the "account created" email with the password is not sent for accounts created by the checkout, the customer order emails (`order_confirmation`, `order_shipped`, `order_delivered`, `order_cancelled`, `order_refunded`) render `{{order_button}}`, `{{order_url_text}}`, `{{order_url}}` and `{{invoice_url}}` as empty strings, and the confirmation pages show no "view your order" link. Credentials an owner or admin sends on purpose ("New customer" with send credentials, "send login link") are not affected. `true` turns it on, `false` or `null` turns it off, any other type is `400 STORE_CHECKOUT_SETTINGS_INVALID`; a body that omits the key keeps the stored value. No password prompt and no security log row. A store email template override that hard-codes `<a href="{{order_url}}">` or `<a href="{{invoice_url}}">` should wrap that link in `{{#if order_url}}` / `{{#if invoice_url}}` before the switch is turned on (blocks cannot be nested, so the link block goes next to the `{{#if invoice_number}}` block, not inside it; templates seeded before this change have the invoice link unguarded and need a re-seed or a manual edit). Repeat purchases on the card / cash-on-delivery checkout form: a returning buyer who is not signed in and uses the same email gets `409 AUTH_EMAIL_EXISTS` from `POST /auth/guest-register` as before; since no password was emailed, the storefront then shows a "choose a password" link to the store's forgot-password page instead of "log in". The Kustom-first checkout reuses the stored customer and is not affected.

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

**LIVE (M118).** (API, storefront and dashboard change together; see the deploy note of the release). Opt-in, default off; needs an `external_site_url`. Owner dashboard: Settings, Checkout behaviour, External website, "Focused storefront".

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

The public `checkout` block carries `"external_focus": true` only while it is on; a store with a site but without it serves exactly the block it served before. The same holds for `"return_label": { ... }` (only when set, next to a valid external site) and `"no_customer_accounts": true` (only while on, with or without a site).

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
- Additive keys documented so far: `max_per_order` on product list and detail (P1); `requires_shipping` on product list and detail, and the `requires_shipping: false` keys of the cart, quote and shipping answers (3.6: only the literal `false` means "no shipping"); inside the store `checkout` block, `external_site_url`, `return_url`, `return_mode`, `back_label` (P3, present only when the store sets an external site) and `external_focus` (focused storefront, 11.5: present, as `true`, only while it is on); `return_label` (11.2: present only when set, next to an external site) and `no_customer_accounts` (11.2: present, as `true`, only while it is on). `email_note` (P4) is never served by these routes.
- 2026-11-18, **LIVE (deployed 2026-11-18)**: `GET /storefront/:slug/products` honours `limit` (first N, still a plain array), and `page` switches to the paged object `{ items, total, page, limit, has_more }`; `sort` applies with either (3.2). A request without `page` and `limit` is unchanged (every product, plain array), so existing clients need no change.
- 2026-11-19, **not deployed yet**: `GET /storefront/:slug/products` accepts the opt-in shopper filters `collection`, `type`, `color`, `size`, `price_min`, `price_max`, `in_stock` and, with `page`, `facets=1` (facet counts), see 3.2. A request without them is unchanged.
- 2026-11-18, **not deployed yet**: `GET /storefront/:slug/products?card=1` adds product card data to each list item (a second image; `variant_option_config` and `compare_at_price` on imported products), see 3.2. A request without `card=1` is unchanged.
