# Playbook: a ShopsDoor store as the purchase step of an external website

How to set up, for a new client, the model first built for Möllstrands Trafikskola (November 2026): the client's own website shows the content and the products, and a ShopsDoor store on its own host does the cart, checkout, payment and order emails.

Audience: whoever sets up the next such store (platform operator or a Claude session). The developer of the external site reads [storefront-api.md](storefront-api.md) instead.

## 1. The model

```
External site (client's domain)                 ShopsDoor store (own host)
  content, SEO, product pages                      product page = "your details" step
  price read from the store API   --buy link-->    cart  ->  checkout  ->  confirmation
  thank-you page  <------------- return button ----------------------------------┘
```

- The site never handles money or personal data. Participant fields, validation, limits and payment live on the store.
- The store is not a second shop: with the **focused storefront** switch its browsing pages redirect to the site and its header and footer are reduced.
- Good fit: services, courses, bookings without a calendar, a small catalogue sold from a content site. Poor fit today: shipped goods (the focused product page shows one image and no shipping table) and designer products (they fall back to the normal product page).

## 2. Platform features this model uses

All are opt-in per store or per product. Stores that do not use them are unchanged.

| Feature | Where it is set | Notes |
|---|---|---|
| Public storefront API | none | Contract in [storefront-api.md](storefront-api.md). Serves only LIVE stores and published products. |
| Participant fields | Product, custom fields | One set per cart line, not per unit. Use `max_per_order = 1` when every participant needs their own data. |
| Personnummer format | Custom field preset "Personnummer (Sweden)" | Checked in the browser and on cart, quote, order and Kustom session. |
| Max per order | Product form, Inventory card | Sums all lines of the product. With tracked stock the lower of the two applies. |
| `?qty=N` | Buy link | Pre-fills the quantity, clamped; never adds to the cart. |
| Email note | Product form, per content locale | Shown under the line in the order confirmation only. |
| External website | Settings, Checkout, External website | Site URL (https, exact host), return URL with `{order_number}`, button or auto, button text. Setting the site URL asks for the owner password. |
| Focused storefront | Same section, switch | Needs an external website. See section 5. |
| Button text after payment | Same section, next to "button text" | `return_label`, per locale: the text of the return button on the paid confirmation page only. Empty = the button text above. |
| Store without customer accounts | Settings, Checkout, checkout behaviour card, switch | `no_customer_accounts`. The account is still created and the order linked to it; the "account created" email is not sent and the "view your order" button and link disappear from the order emails and the confirmation page. Works without an external website. Check the store's email template overrides for a hard-coded `{{order_url}}` or `{{invoice_url}}` link first (wrap each in its own `{{#if ...}}` block). Limit: on the card / cash-on-delivery form a returning buyer with the same email must choose a password first (the checkout shows the link); the Kustom-first checkout has no such step. |
| `?back=<path>` | Buy link | Same-site path; the store's logo, back link and "continue shopping" return there. |
| Footer links | Menus, menu with key `footer` | Shown in the focused footer. Without it the store's legal pages are listed. |

## 3. Set-up steps, in order

Each step names who can do it. "Owner" = the store owner login in the dashboard (or the owner API). "Admin" = platform admin. "Server" = the server session.

1. **Catalogue file** (operator). One JSON with store data, collections, products (slug, title, price, collection, `max_per_order`, descriptions, publish flag) and the participant fields. Model: `client-stores/mollstrands/catalog.json` (outside git). Product slugs should equal the product path segments of the external site, so both sides share one identifier.
2. **Create the store** (server; script run from the API directory). Model: `scripts/ops/mollstrands-store-create.js`: dry run by default, `--apply` to write, re-runnable. It creates the owner, the store (DRAFT, INDEPENDENT), the default market, collections, products and fields. It is written for one store slug: copy and adapt it for the next client rather than parameterising in a hurry.
3. **Enable the `markets` store app** (admin makes it available, owner enables it; or the server adds the StoreApp row). Required for no-index on the platform subdomain: see section 6, pitfall 1.
4. **Legal pages** (owner): create Privacy and Terms from the template and publish them. Go-live is blocked without them for INDEPENDENT stores.
5. **A payment method** (owner): Kustom or the store's own Stripe key when the client's credentials exist; cash on delivery as a temporary test method (`cod_enabled`).
6. **Go-live** (owner requests, admin approves). The store must be LIVE before the API serves its products.
7. **Look and settings** (owner). Model: `scripts/ops/mollstrands-store-setup.js` (owner API, dry run by default, idempotent, saves the old values first): theme colours and fonts (`theme_customizations`), logo and favicon, the order confirmation text, storefront cache off, product images, the `footer` menu, and the external website block.
8. **External website and focus** (owner): site URL, return URL, button text; "after add to cart" = go to cart; switch on Focused storefront.
9. **Hand the values to the site developer**: API base `https://api.shopsdoor.com/api`, the store slug, the store origin for buy links (`https://<slug>.shopsdoor.com` until a custom domain exists; after that the payload's `custom_domain`), and [storefront-api.md](storefront-api.md).
10. **Test a full purchase** with the test payment method: buy link with `back` → details → cart → checkout → confirmation email (items, fields, email note) → return button → thank-you page with the order number.
11. **Before launch**: the client's payment credentials, the notification email, the sender domain for emails, the client's legal texts, the tracking ids, the custom domain, and the external site URL changed from the staging host to the real one (the footer menu links too).

Secrets: an owner password is never read by a session. Steps that need one are scripts the human owner runs on the server (the two model scripts follow this), unless the owner hands a throwaway password over for the task and changes it afterwards.

## 4. What the external site must do

- Read products and prices server-side from the API; never hard-code a price. A product missing from the API is not for sale (show a contact link).
- Buy button: a plain link to `<store origin>/products/<slug>`, with `?qty=N` only up to the product's `max_per_order`, and `&back=<url-encoded path of the current page>`.
- A thank-you page for the return URL: static text plus the order number from the query, validated as plain text, no order lookup, no purchase event (the store's confirmation already sends it), `noindex`.
- Keep the paths that the store's footer menu links to stable.

## 5. Focused storefront: what it does and what controls it

Behaviour (only with a valid external website and the switch on):

| Area | Behaviour |
|---|---|
| Redirected (307) to the site | Home, collections, the product listing, content pages |
| Kept | Product pages, cart, checkout and confirmation, account, sign-in, legal pages, the cookie page, policy pages by name (English and Swedish words) |
| Header | Logo (to the site), back link, cart, and a step indicator on product, cart and checkout |
| Footer | Dark band derived from the primary colour: logo, seller contact details, links, legal line |
| Product page | A details card with the fields in two columns, a price card with the first image, the long description folded |
| After add to cart | The cart page, unless the store chose "go to checkout" |
| Sitemap | Product pages only |
| Not applied | While the store is not LIVE, in the owner's preview, and when the site host is one of the store's own hosts |

What the owner controls from the dashboard: colours, fonts, logo, footer links (menu `footer`), seller details, the back button text, participant fields, the switch itself. What needs a code change: the arrangement of the header, footer and product page, the step labels, the darkness of the footer. The page builder does not apply in this mode: a published header, footer or product template is ignored while the switch is on.

Code map (web): gate `src/lib/focusedStorefront.ts`; redirects `src/lib/focusedStorefront.server.ts`; back path `src/lib/focusedBack.ts`; chrome `src/components/layout/FocusedHeader.tsx`, `FocusedFooter.tsx`; product page `src/components/product/focused/`. API: `src/modules/stores/checkout-settings.ts`, `external-site-hosts.ts`. Dashboard: `CheckoutSettingsCard`.

## 6. Pitfalls found the first time

1. **A new store on the platform subdomain is indexable** unless the `markets` app is on. The no-index rule for the subdomain belongs to the market (indexing AUTO = no-index without a custom domain). Check the `x-robots-tag` header after go-live.
2. **The API serves nothing while the store is DRAFT or pending review.** The site's production build should fail loudly in that state rather than publish without prices.
3. **Platform categories**: every product needs one and none fits services; `gifts` was used as a placeholder. It is not shown on an independent storefront.
4. **Return URL**: https only, and the host must equal the site host exactly (or its `www.` twin). `http://localhost` cannot be used; test against an https staging host.
5. **The site URL may not be a platform host or one of the store's own hosts** (it would loop). The rule is checked when the site changes or the focus is turned on.
6. **Footer menu replaces the legal list.** If the `footer` menu has items, the store's own legal pages are not listed; keep the terms and privacy links in the menu.
7. **Absolute links in the footer menu point at the staging host** until someone changes them at launch.
8. **Order confirmation template**: a store override freezes the layout of that email for the store; later changes to the platform default do not reach it.
9. **Test orders reach whoever the notification email names**: leave it on the operator's address until launch.
10. **Unconfirmed client data**: prices and titles came from the client's old pages; keep a list of what the client must confirm (model: `client-stores/mollstrands/PRICES-TO-CONFIRM.md`).
11. **Server memory**: the production server was close to its limit during these deploys (one API build was killed and rolled back by itself). Build one app at a time.

## 7. Not built yet

- Filling the participant fields on the external site and landing directly in the cart (planned next; the store product page stays as the fallback).
- Options for the focused layout in the dashboard (show or hide the steps, footer colour, phone in the header, a second product layout).
- A storefront API key and allowed origins for browser calls (the API is called server-side today).
- Outbound webhooks to the external site.
- Per-unit participant data (one set per cart line today).

## 8. Reference: the Möllstrands instance

| Item | Value |
|---|---|
| Store | slug `mollstrands`, `https://mollstrands.shopsdoor.com`, INDEPENDENT, SEK, sv |
| External site | staging `https://mollstrands.vercel.app` (repo `C:\Projects\mollstrands`); final domain mollstrands.se, store later on checkout.mollstrands.se |
| Catalogue | 27 service products (26 published), 4 collections, 8 participant fields per published product |
| Client material and hand-off | `client-stores/mollstrands/` (outside git): `catalog.json`, `handoff/`, `store-assets/` |
| Plans | `plans/headless-booking/` (PLAN, TRACKER, P6-STORE-SETUP, HANDOFF-CUSTOM-SITE) |
| Deploys | `plans/namez-store-apps/`: M115 (platform features), M118 (focused storefront), M119 (focused look, `?back=`); PROGRESS rows 8.08 to 8.14 |
