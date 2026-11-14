/**
 * One-off content fix (Namez legal, 2026-11): rewrite Namez's cookie page
 * (/om-cookies) and privacy policy (/legal/privacy) so they cover what the
 * store actually runs: necessary storage (cart, consent choice, login,
 * Kustom/Klarna checkout, Cloudflare), Google Analytics 4, Microsoft Clarity
 * (recordings + heatmaps), Meta Pixel + Conversions API, external videos
 * (YouTube/Vimeo two-click), retention, how to change consent, GDPR rights,
 * IMY and the contact e-mail.
 *
 * Source texts: plans/namez-legal/{om-cookies,privacy}.{sv,en}.md, embedded
 * below verbatim (Markdown subset) and converted to HTML at run time. Swedish
 * goes to the Swedish locale(s); every other store locale gets English.
 *
 * What it writes (one transaction, non-destructive):
 *   1. /om-cookies (existing v2 page): the visible root `rich-text`
 *      section(s) are only HIDDEN (they stay in the builder draft), a new
 *      rich-text section with the new text takes the first one's place; the
 *      hero banner (page H1) and every other section stay as they are. The
 *      page meta descriptions are replaced (the old text said "we collect no
 *      personal information").
 *   2. Privacy policy: the store's v2 STATIC page of kind PRIVACY_POLICY.
 *      When it exists, its visible root sections are hidden and the new
 *      rich-text section is added; otherwise the page is created
 *      (slug `integritetspolicy`). A published v2 page of this kind is what
 *      `/legal/privacy` shows instead of the default template
 *      (store-legal-resolver.ts: "v2 wins").
 *   Both pages are then published through the same snapshot shape as the
 *   builder (pages-v2 buildPublishSnapshot); the previous published version
 *   stays in the page's version history for a one-click restore.
 *
 *   node scripts/ops/namez-cookie-privacy-pages.js               (dry run)
 *   node scripts/ops/namez-cookie-privacy-pages.js --print-html  (dry run + HTML)
 *   node scripts/ops/namez-cookie-privacy-pages.js --apply       (write + publish)
 *
 * A page that already has a version with this script's label is skipped, so
 * a second run changes nothing.
 *
 * Publishing snapshots the whole working draft. If a page's draft differs
 * from its published version (unpublished builder edits), the dry run lists
 * the differences and --apply refuses, unless --publish-draft-changes is
 * given on purpose (those edits would go live together with the legal text).
 *
 * Must run from the API directory with the production environment loaded
 * (DATABASE_URL; STOREFRONT_URL + REVALIDATE_SECRET for the cache refresh).
 * No secret is ever printed.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const STORE_SLUG = 'namez-se';
const COOKIE_PAGE_SLUG = 'om-cookies';
const PRIVACY_PAGE_SLUG = 'integritetspolicy';
const COOKIE_LABEL = 'Namez legal 2026-11: cookie page (GA4, Clarity, Meta, external video)';
const PRIVACY_LABEL = 'Namez legal 2026-11: privacy policy (GA4, Clarity, Meta, external video)';
const APPLY = process.argv.includes('--apply');
const PRINT_HTML = process.argv.includes('--print-html');
const PUBLISH_DRAFT_CHANGES = process.argv.includes('--publish-draft-changes');

const META = {
  cookies: {
    sv:
      'Vilka cookies namez.se använder (nödvändiga, Google Analytics, Microsoft Clarity, ' +
      'Meta Pixel, YouTube/Vimeo), hur länge de sparas och hur du ändrar ditt val.',
    en:
      'Which cookies namez.se uses (necessary, Google Analytics, Microsoft Clarity, ' +
      'Meta Pixel, YouTube/Vimeo), how long they are kept and how to change your choice.',
  },
  privacy: {
    sv:
      'Hur namez AB behandlar dina personuppgifter: beställningar, betalning, cookies, ' +
      'statistik och marknadsföring, lagringstider och dina rättigheter enligt GDPR.',
    en:
      'How namez AB processes your personal data: orders, payment, cookies, analytics ' +
      'and marketing, retention periods and your rights under the GDPR.',
  },
};

/* ------------------------------------------------------------------ */
/* Texts (verbatim copies of plans/namez-legal/*.md)                    */
/* ------------------------------------------------------------------ */

// plans/namez-legal/om-cookies.sv.md
const COOKIES_SV = `
# Om cookies

*Senast uppdaterad: november 2026*

Här förklarar vi vilka cookies och liknande tekniker som används på namez.se, varför de används, hur länge de sparas och hur du ändrar ditt val. Webbplatsen drivs av namez AB, org.nr 559295-1007. Hur vi behandlar personuppgifter i övrigt beskrivs i vår [integritetspolicy](/legal/privacy).

## Vad är cookies?

Cookies är små textfiler som sparas i din webbläsare när du besöker en webbplats. Liknande tekniker är till exempel lokal lagring i webbläsaren (localStorage och sessionStorage) och skript eller pixlar från andra företag. På den här sidan kallar vi allt detta för cookies.

## Ditt val

Första gången du besöker namez.se visas en cookieruta där du väljer **Acceptera alla** eller **Avböj**.

- **Nödvändiga cookies** används alltid. Utan dem fungerar inte butiken, och de kräver inget samtycke.
- **Statistik och analys** (Google Analytics och Microsoft Clarity) och **marknadsföring** (Meta Pixel) används bara om du väljer Acceptera alla. Innan du har valt laddas inga sådana tjänster.
- Om du väljer Avböj fungerar butiken precis som vanligt.
- Ditt val sparas i 12 månader. Därefter frågar vi igen, och vi frågar också igen om vi börjar använda nya tjänster.

### Så ändrar eller återkallar du ditt samtycke

Klicka på **Cookieinställningar** längst ner på sidan. Då visas cookierutan igen och du kan göra ett nytt val. Länken nollställer alla dina val på en gång: både valet i cookierutan och ett eventuellt val att alltid tillåta externa videor (se nedan). När du återkallar ditt samtycke slutar tjänsterna att användas direkt (sidan laddas om) och Clarity raderar sina cookies. Cookies som Google och Meta redan har satt kan du radera i webbläsarens inställningar. Du kan också blockera cookies helt i webbläsaren, men då fungerar inte varukorgen och kassan.

## Nödvändiga cookies

Dessa behövs för att butiken ska fungera och vara säker. De används utan samtycke.

- **guest_cart** och **guest_coupon** (lokal lagring) – kommer ihåg din varukorg och en rabattkod när du inte är inloggad. Sparas tills varukorgen töms, köpet är genomfört eller du rensar webbläsarens data.
- **consent:namez-se** (lokal lagring) och **consent_namez-se** (cookie) – sparar ditt cookieval. 12 månader.
- **consent:namez-se:external-media** (lokal lagring) och **xmedia_namez-se** (cookie) – sparar ditt val **Tillåt alltid externa videor**. Sätts bara om du gör det valet. 12 månader.
- **auth_access_token** och **auth_refresh_token** (lokal lagring) – håller dig inloggad på ditt kundkonto. Tills du loggar ut.
- **x-store-locale** (cookie) – kommer ihåg vilket språk sidan visas på. Raderas när du stänger webbläsaren.
- **ms-buyer-type** (cookie) – kommer ihåg om du handlar som privatperson eller företag, så att rätt priser och moms visas. 12 månader.
- **ms-market-suggest-dismissed** (cookie) – kommer ihåg att du har stängt förslaget att byta till en annan landsversion av butiken. 12 månader.
- **kustom_checkout_session:namez-se** (sessionslagring) – kopplar dig till din pågående betalning i kassan. Raderas när du stänger fliken.
- **Kassan (Kustom och Klarna)** – kassan visas i en ruta från Kustom. Kustom och Klarna sätter egna nödvändiga cookies för att genomföra betalningen, förebygga bedrägerier och komma ihåg dina uppgifter i kassan. Läs mer i Kustoms integritetspolicy (länkad i kassan) och i [Klarnas integritetspolicy](https://www.klarna.com/se/dataskydd/).
- **__cf_bm** och **cf_clearance** (Cloudflare) – Cloudflare skyddar webbplatsen mot överbelastning och skadlig trafik. __cf_bm sparas i 30 minuter. cf_clearance sätts bara när du har klarat en säkerhetskontroll och sparas så länge kontrollen gäller.

## Statistik och analys (kräver samtycke)

### Google Analytics 4

**Leverantör:** Google Ireland Limited (Irland) och Google LLC (USA). **Mät-ID:** G-0LQ8TWPC6V.

**Varför:** för statistik över hur butiken används, till exempel vilka sidor som besöks, hur länge, från vilken typ av enhet, ungefärlig plats (land och stad) och vilka köp som genomförs. Vi använder statistiken för att förbättra butiken och mäta våra kampanjer. Google sparar inte IP-adresser för besökare i EU.

- **_ga** – skiljer besökare åt. 2 år.
- **_ga_0LQ8TWPC6V** – kommer ihåg din pågående session. 2 år.

Läs mer i [Googles integritetspolicy](https://policies.google.com/privacy) och om [hur Google använder uppgifter från webbplatser](https://policies.google.com/technologies/partner-sites).

### Microsoft Clarity

**Leverantör:** Microsoft Ireland Operations Limited (Irland) och Microsoft Corporation (USA). **Projekt-ID:** sxtuobatm6.

**Varför:** värmekartor (heatmaps) och sessionsinspelningar visar hur besökare använder butiken: klick, skrollning, musrörelser, besökta sidor, enhet, webbläsare och ungefärlig plats. Det hjälper oss att hitta och rätta till problem, till exempel knappar som är svåra att hitta.

**Skydd av dina uppgifter:** det du skriver i formulär, personliga texter på produkter, varukorgen och kassan maskeras (döljs) i inspelningarna. Clarity används inte alls på inloggningssidor, på Mina sidor eller på orderbekräftelsen, och betaluppgifter spelas aldrig in.

- **_clck** – känner igen en återkommande besökare i Clarity. 1 år.
- **_clsk** – kopplar ihop sidvisningar till en och samma inspelning. 1 dag.
- **CLID**, **MUID** och **ANONCHK** – Microsofts egna cookies, som Microsoft kan sätta i vissa fall och som vi inte kan radera åt dig. CLID och MUID: 1 år. ANONCHK: 10 minuter.

Inspelningar sparas hos Microsoft i upp till 30 dagar. Sammanställda värmekartor och inspelningar som vi särskilt sparar finns kvar i upp till 13 månader. Microsoft behandlar uppgifterna för att tillhandahålla Clarity åt oss och är dessutom själv ansvarig för den behandling som Microsoft gör för egna ändamål, till exempel för att förbättra och skydda sina tjänster. Läs mer i [Microsofts sekretesspolicy](https://privacy.microsoft.com/sv-se/privacystatement).

### Övrigt

- **ms:purchase-tracked:…** (lokal lagring) – ser till att samma köp inte räknas två gånger i statistiken hos Google och Meta. Sparas tills du rensar webbläsarens data. Används bara om du har valt Acceptera alla.

## Marknadsföring (kräver samtycke)

### Meta Pixel

**Leverantör:** Meta Platforms Ireland Limited (Irland) och Meta Platforms, Inc. (USA). **Pixel-ID:** 1064861581891343.

**Varför:** för att mäta hur våra annonser på Facebook och Instagram fungerar, till exempel hur många som besöker butiken eller handlar efter att ha sett en annons, och för att visa våra annonser för personer som kan vara intresserade. Meta får uppgifter om vilka sidor du besöker, vilka produkter du tittar på, lägger i varukorgen eller köper, ordervärde, IP-adress, webbläsare och enhet.

När du genomför ett köp och har valt Acceptera alla skickar vi också köpet direkt från vår server till Meta (Meta Conversions API), så att köpet räknas även om webbläsaren blockerar pixeln. Då skickas ordervärde, produkter, IP-adress, webbläsare och dina kontaktuppgifter (e-post, telefon, namn, ort, postnummer och land) i hashad form, det vill säga omvandlade till en kod som inte kan läsas direkt.

- **_fbp** – känner igen din webbläsare för att mäta annonser. 90 dagar.
- **_fbc** – sparar vilken annons du klickade på, om du kom till oss via en annons. 90 dagar.

namez AB och Meta är gemensamt personuppgiftsansvariga för insamlingen av uppgifterna och överföringen till Meta, enligt [Metas tillägg för personuppgiftsansvariga](https://www.facebook.com/legal/controller_addendum). Meta ansvarar ensamt för sin fortsatta behandling, se [Metas integritetspolicy](https://www.facebook.com/privacy/policy/). Du kan styra vilka annonser du ser i dina [annonsinställningar hos Meta](https://accountscenter.facebook.com/ad_preferences).

## Externa videor och kartor (YouTube, Vimeo och Google Maps)

Vissa sidor kan visa videor som ligger hos YouTube (Google) eller Vimeo. Sådana videor laddas inte förrän du klickar på **Spela upp video** eller har valt **Tillåt alltid externa videor**. Fram till dess visas en bild och en kort information om att videon finns hos YouTube eller Vimeo.

- När du klickar på **Spela upp video** hämtas just den videon, från youtube-nocookie.com (YouTubes läge för utökad integritet) eller från Vimeo med spårningsskydd (Do Not Track). Då får YouTube eller Vimeo din IP-adress och uppgifter om din webbläsare och kan sätta cookies eller använda lokal lagring, även för egna ändamål.
- Om du väljer **Tillåt alltid externa videor** sparar vi det valet i din webbläsare (lokal lagring och en cookie) i 12 månader. Då laddas videor från YouTube och Vimeo direkt när du besöker en sida med en sådan video, och vissa av dem kan starta automatiskt utan ljud när de syns på skärmen. Du kan ändra valet när som helst via Cookieinställningar.
- Leverantörer: Google Ireland Limited och Google LLC (YouTube, se [Googles integritetspolicy](https://policies.google.com/privacy)) samt Vimeo.com, Inc. (USA, se [Vimeos integritetspolicy](https://vimeo.com/privacy)).

Videor som vi själva laddar upp spelas från vår egen server och sätter inga cookies. Vissa av dem kan starta automatiskt utan ljud när de syns på skärmen. Det gör de inte om du har valt minskade animationer eller datasparläge på din enhet.

Kartan på sidan Kontakta oss kommer från Google Maps (Google Ireland Limited och Google LLC). Den laddas först när du klickar på **Visa karta**, och bara för det besöket. Då får Google din IP-adress och uppgifter om din webbläsare och kan sätta cookies, även för egna ändamål. Se [Googles integritetspolicy](https://policies.google.com/privacy).

## Överföring till USA

Google, Microsoft, Meta, Vimeo och Cloudflare kan överföra uppgifter till USA. Överföringen sker med stöd av EU–US Data Privacy Framework (EU-kommissionens beslut om adekvat skyddsnivå) för de företag som är certifierade enligt det, och i övrigt med stöd av EU-kommissionens standardavtalsklausuler.

## Kontakt

Har du frågor om cookies eller om hur vi behandlar dina uppgifter? Kontakta oss på [info@namez.se](mailto:info@namez.se) eller 0243-33 32 43. namez AB, Hagavägen 36, 784 40 Borlänge. Läs mer om dina rättigheter i vår [integritetspolicy](/legal/privacy).
`;

// plans/namez-legal/om-cookies.en.md
const COOKIES_EN = `
# About cookies

*Last updated: November 2026*

This page explains which cookies and similar technologies are used on namez.se, why they are used, how long they are kept and how you change your choice. The website is run by namez AB, company reg. no. 559295-1007. How we process personal data in general is described in our [privacy policy](/legal/privacy).

## What are cookies?

Cookies are small text files that are stored in your browser when you visit a website. Similar technologies include storage in the browser (localStorage and sessionStorage) and scripts or pixels from other companies. On this page we call all of these cookies.

## Your choice

The first time you visit namez.se, a cookie banner lets you choose **Accept all** or **Decline**.

- **Necessary cookies** are always used. The store does not work without them, and they do not require consent.
- **Statistics and analytics** (Google Analytics and Microsoft Clarity) and **marketing** (Meta Pixel) are only used if you choose Accept all. Until you have chosen, none of these services is loaded.
- If you choose Decline, the store works just as usual.
- Your choice is kept for 12 months. After that we ask again, and we also ask again if we start using new services.

### How to change or withdraw your consent

Click **Cookie settings** at the bottom of the page. The cookie banner then appears again and you can make a new choice. The link resets all your choices at once: both the choice in the cookie banner and any choice to always allow external videos (see below). When you withdraw your consent, the services stop immediately (the page reloads) and Clarity deletes its cookies. Cookies that Google and Meta have already set can be deleted in your browser settings. You can also block cookies completely in your browser, but then the cart and the checkout will not work.

## Necessary cookies

These are needed for the store to work and to be secure. They are used without consent.

- **guest_cart** and **guest_coupon** (local storage) – remember your cart and a discount code when you are not logged in. Kept until the cart is emptied, the purchase is completed or you clear your browser data.
- **consent:namez-se** (local storage) and **consent_namez-se** (cookie) – store your cookie choice. 12 months.
- **consent:namez-se:external-media** (local storage) and **xmedia_namez-se** (cookie) – store your choice **Always allow external videos**. Only set if you make that choice. 12 months.
- **auth_access_token** and **auth_refresh_token** (local storage) – keep you logged in to your customer account. Until you log out.
- **x-store-locale** (cookie) – remembers the language the site is shown in. Deleted when you close the browser.
- **ms-buyer-type** (cookie) – remembers whether you shop as a private person or a business, so that the right prices and VAT are shown. 12 months.
- **ms-market-suggest-dismissed** (cookie) – remembers that you closed the suggestion to switch to another country version of the store. 12 months.
- **kustom_checkout_session:namez-se** (session storage) – links you to your ongoing payment in the checkout. Deleted when you close the tab.
- **The checkout (Kustom and Klarna)** – the checkout is shown in a frame from Kustom. Kustom and Klarna set their own necessary cookies to carry out the payment, prevent fraud and remember your details in the checkout. Read more in Kustom's privacy policy (linked in the checkout) and in [Klarna's privacy policy](https://www.klarna.com/international/privacy-policy/).
- **__cf_bm** and **cf_clearance** (Cloudflare) – Cloudflare protects the website against overload and malicious traffic. __cf_bm is kept for 30 minutes. cf_clearance is only set after you have passed a security check and is kept for as long as that check is valid.

## Statistics and analytics (consent required)

### Google Analytics 4

**Provider:** Google Ireland Limited (Ireland) and Google LLC (USA). **Measurement ID:** G-0LQ8TWPC6V.

**Why:** for statistics on how the store is used, for example which pages are visited, for how long, from which type of device, approximate location (country and city) and which purchases are made. We use the statistics to improve the store and measure our campaigns. Google does not store IP addresses of visitors in the EU.

- **_ga** – distinguishes visitors. 2 years.
- **_ga_0LQ8TWPC6V** – remembers your current session. 2 years.

Read more in [Google's privacy policy](https://policies.google.com/privacy) and about [how Google uses information from sites](https://policies.google.com/technologies/partner-sites).

### Microsoft Clarity

**Provider:** Microsoft Ireland Operations Limited (Ireland) and Microsoft Corporation (USA). **Project ID:** sxtuobatm6.

**Why:** heatmaps and session recordings show how visitors use the store: clicks, scrolling, mouse movements, pages visited, device, browser and approximate location. This helps us find and fix problems, for example buttons that are hard to find.

**Protecting your data:** what you type into forms, personalisation texts on products, the cart and the checkout are masked (hidden) in the recordings. Clarity is not used at all on login pages, on My account or on the order confirmation, and payment details are never recorded.

- **_clck** – recognises a returning visitor in Clarity. 1 year.
- **_clsk** – links page views into one recording. 1 day.
- **CLID**, **MUID** and **ANONCHK** – Microsoft's own cookies, which Microsoft may set in some cases and which we cannot delete for you. CLID and MUID: 1 year. ANONCHK: 10 minutes.

Recordings are kept by Microsoft for up to 30 days. Aggregated heatmaps and recordings that we specifically save are kept for up to 13 months. Microsoft processes the data to provide Clarity to us and is also itself responsible for the processing Microsoft carries out for its own purposes, for example to improve and secure its services. Read more in the [Microsoft Privacy Statement](https://privacy.microsoft.com/en-gb/privacystatement).

### Other

- **ms:purchase-tracked:…** (local storage) – makes sure the same purchase is not counted twice in the statistics at Google and Meta. Kept until you clear your browser data. Only used if you chose Accept all.

## Marketing (consent required)

### Meta Pixel

**Provider:** Meta Platforms Ireland Limited (Ireland) and Meta Platforms, Inc. (USA). **Pixel ID:** 1064861581891343.

**Why:** to measure how our ads on Facebook and Instagram perform, for example how many people visit the store or buy after seeing an ad, and to show our ads to people who may be interested. Meta receives information about the pages you visit, the products you view, add to the cart or buy, order value, IP address, browser and device.

When you complete a purchase and have chosen Accept all, we also send the purchase directly from our server to Meta (Meta Conversions API), so that it is counted even if the browser blocks the pixel. This sends the order value, products, IP address, browser and your contact details (email, phone, name, city, postcode and country) in hashed form, that is, converted into a code that cannot be read directly.

- **_fbp** – recognises your browser to measure ads. 90 days.
- **_fbc** – stores which ad you clicked, if you came to us through an ad. 90 days.

namez AB and Meta are joint controllers for collecting the data and transmitting it to Meta, under the [Meta Controller Addendum](https://www.facebook.com/legal/controller_addendum). Meta alone is responsible for its further processing, see [Meta's privacy policy](https://www.facebook.com/privacy/policy/). You can control which ads you see in your [ad preferences at Meta](https://accountscenter.facebook.com/ad_preferences).

## External videos and maps (YouTube, Vimeo and Google Maps)

Some pages may show videos hosted by YouTube (Google) or Vimeo. Such videos are not loaded until you click **Play video** or have chosen **Always allow external videos**. Until then, an image is shown with a short notice that the video is hosted by YouTube or Vimeo.

- When you click **Play video**, only that video is loaded, from youtube-nocookie.com (YouTube's privacy-enhanced mode) or from Vimeo with tracking protection (Do Not Track). YouTube or Vimeo then receive your IP address and information about your browser and may set cookies or use local storage, also for their own purposes.
- If you choose **Always allow external videos**, we store that choice in your browser (local storage and a cookie) for 12 months. Videos from YouTube and Vimeo then load directly when you visit a page with such a video, and some of them may start automatically without sound when they appear on the screen. You can change this choice at any time via Cookie settings.
- Providers: Google Ireland Limited and Google LLC (YouTube, see [Google's privacy policy](https://policies.google.com/privacy)) and Vimeo.com, Inc. (USA, see [Vimeo's privacy policy](https://vimeo.com/privacy)).

Videos that we upload ourselves are played from our own server and set no cookies. Some of them may start automatically without sound when they appear on the screen. They do not if you have chosen reduced motion or data saver mode on your device.

The map on the Contact page comes from Google Maps (Google Ireland Limited and Google LLC). It is only loaded when you click **Show map**, and only for that visit. Google then receives your IP address and information about your browser and may set cookies, also for its own purposes. See [Google's privacy policy](https://policies.google.com/privacy).

## Transfers to the USA

Google, Microsoft, Meta, Vimeo and Cloudflare may transfer data to the USA. The transfer is based on the EU–US Data Privacy Framework (the European Commission's adequacy decision) for the companies certified under it, and otherwise on the European Commission's standard contractual clauses.

## Contact

Questions about cookies or how we process your data? Contact us at [info@namez.se](mailto:info@namez.se) or +46 243-33 32 43. namez AB, Hagavägen 36, 784 40 Borlänge, Sweden. Read more about your rights in our [privacy policy](/legal/privacy).
`;

// plans/namez-legal/privacy.sv.md
const PRIVACY_SV = `
# Integritetspolicy

*Senast uppdaterad: november 2026*

I denna integritetspolicy beskriver vi hur namez AB behandlar dina personuppgifter när du besöker namez.se, handlar hos oss eller kontaktar oss. Vi behandlar bara de uppgifter som behövs, och vi säljer aldrig dina personuppgifter.

## 1. Personuppgiftsansvarig

namez AB, org.nr 559295-1007, Hagavägen 36, 784 40 Borlänge, är personuppgiftsansvarig för behandlingen av dina personuppgifter. Kontakt: [info@namez.se](mailto:info@namez.se), telefon 0243-33 32 43.

Butiken är byggd på e-handelsplattformen ShopsDoor, som också drivs av namez AB. Ingen annan plattformsleverantör får alltså tillgång till dina uppgifter genom butiken.

## 2. Vilka uppgifter vi behandlar

- **Identitets- och kontaktuppgifter** – namn, e-postadress, telefonnummer samt leverans- och faktureringsadress. Handlar du som företag även företagsnamn, organisationsnummer och momsnummer.
- **Orderuppgifter** – vad du har köpt, priser, rabattkoder, orderhistorik, leveranser, returer och reklamationer.
- **Uppgifter för personliga produkter** – texter, namn, datum och bilder som du anger eller laddar upp för att vi ska kunna tillverka din produkt.
- **Betalningsuppgifter** – betalsätt och om betalningen har gått igenom. Kort- och bankuppgifter hanteras av betaltjänstleverantören; vi ser eller sparar aldrig fullständiga kortnummer.
- **Kontouppgifter** – om du skapar ett kundkonto: inloggningsuppgifter och sparade adresser.
- **Kommunikation** – meddelanden till vår kundtjänst och, om du har anmält dig, prenumeration på nyhetsbrev.
- **Kundberättelser och recensioner** – om du har gett oss tillåtelse: ditt namn, din kommentar, ditt betyg och den bild eller video du har skickat in.
- **Tekniska uppgifter** – IP-adress, webbläsare, enhet, ungefärlig plats och hur du använder webbplatsen, som samlas in via cookies och liknande tekniker (se avsnitt 7).

## 3. Varför vi behandlar uppgifterna och med vilket stöd

- Hantera, tillverka och leverera din beställning samt hantera betalning, retur och reklamation – *fullgörande av avtal* (art. 6.1 b GDPR).
- Tillhandahålla ditt kundkonto – *fullgörande av avtal*.
- Bokföring och andra skyldigheter enligt lag, till exempel bokföringslagen och konsumentlagstiftningen – *rättslig förpliktelse* (art. 6.1 c).
- Kundservice, att förebygga bedrägerier och missbruk, att skydda webbplatsen (bland annat via Cloudflare) samt att fastställa, göra gällande eller försvara rättsliga anspråk – *berättigat intresse* (art. 6.1 f).
- Nyhetsbrev och marknadsföring via e-post – ditt *samtycke* (art. 6.1 a) eller, där lagen tillåter det, vårt berättigade intresse av att erbjuda befintliga kunder liknande produkter. Du kan alltid tacka nej via länken i varje utskick.
- Publicera kundberättelser och recensioner med ditt namn, bild eller video – ditt *samtycke*.
- Statistik och analys (Google Analytics och Microsoft Clarity) samt marknadsföring (Meta Pixel och Meta Conversions API) – ditt *samtycke* (art. 6.1 a GDPR och 9 kap. 28 § lagen om elektronisk kommunikation).

## 4. Hur länge vi sparar uppgifterna

- Räkenskapsinformation, till exempel kvitton och fakturor, sparas i sju år efter utgången av det kalenderår då räkenskapsåret avslutades, enligt bokföringslagen (1999:1078).
- Övriga order- och kundtjänstuppgifter, inklusive texter och bilder för personliga produkter, sparas så länge de behövs för köpet, returer och reklamationer – normalt i upp till tre år från leveransen (reklamationsfristen) och längre endast om ett ärende pågår.
- Kontouppgifter sparas tills du avslutar ditt konto.
- Uppgifter för marknadsföring sparas tills du återkallar ditt samtycke eller avregistrerar dig.
- Kundberättelser och recensioner visas tills du ber oss ta bort dem.
- Cookies sparas så länge som anges på sidan [Om cookies](/om-cookies). Inspelningar i Microsoft Clarity sparas i upp till 30 dagar, och statistik i Google Analytics sparas i upp till 14 månader.

## 5. Vilka vi delar uppgifter med

- **Betaltjänstleverantörer** – kassan tillhandahålls av Kustom, och betalning med faktura och delbetalning sker via Klarna Bank AB (publ). De behandlar uppgifter för att genomföra betalningen och, vid faktura och delbetalning, för identitets- och kreditkontroll, vilket kan innebära ett automatiserat beslut. Kustom och Klarna är självständigt personuppgiftsansvariga för de uppgifter de samlar in i kassan, enligt sina egna integritetspolicyer.
- **Transportföretag** – namn, adress, telefonnummer och e-postadress för att leverera ditt paket och skicka leveransaviseringar.
- **IT-leverantörer (personuppgiftsbiträden)** – för serverdrift och lagring, e-postutskick och skydd av webbplatsen (Cloudflare). De får bara behandla uppgifterna enligt våra instruktioner.
- **Analys- och annonspartner** – Google (Google Analytics), Microsoft (Clarity) och Meta (Meta Pixel och Conversions API), endast om du har samtyckt. Se avsnitt 7 och sidan [Om cookies](/om-cookies).
- **YouTube, Vimeo och Google Maps** – endast om du väljer att spela upp en extern video eller visa kartan (se avsnitt 7).
- **Myndigheter och rådgivare** – när lagen kräver det (till exempel Skatteverket), för att tillvarata våra rättsliga anspråk, samt vår redovisningskonsult eller revisor.

## 6. Överföring utanför EU/EES

Vi strävar efter att behandla uppgifter inom EU/EES. Google, Microsoft, Meta, Vimeo och Cloudflare kan överföra uppgifter till USA. Överföringen sker med stöd av EU–US Data Privacy Framework (EU-kommissionens beslut om adekvat skyddsnivå) för de företag som är certifierade enligt det, och i övrigt med stöd av EU-kommissionens standardavtalsklausuler.

## 7. Cookies, statistik och marknadsföring

Vi använder nödvändiga cookies för att butiken ska fungera, till exempel för varukorgen, inloggningen, språkvalet och kassan. De kräver inget samtycke. Allt annat används bara om du väljer **Acceptera alla** i cookierutan:

- **Google Analytics 4** (Google Ireland Limited; Google LLC, USA) – statistik över hur butiken används och vilka köp som görs. Google sparar inte IP-adresser för besökare i EU.
- **Microsoft Clarity** (Microsoft Ireland Operations Limited; Microsoft Corporation, USA) – värmekartor och sessionsinspelningar som visar hur besökare klickar, skrollar och rör sig på sidorna, så att vi kan rätta till problem. Det du skriver i formulär, personliga texter, varukorgen och kassan maskeras, och Clarity används inte på inloggningssidor, Mina sidor eller orderbekräftelsen. Microsoft är dessutom självständigt ansvarig för den behandling som Microsoft gör för egna ändamål.
- **Meta Pixel och Meta Conversions API** (Meta Platforms Ireland Limited; Meta Platforms, Inc., USA) – för att mäta och förbättra våra annonser på Facebook och Instagram. Vid ett köp skickar vi också köpet och dina kontaktuppgifter i hashad form från vår server till Meta. namez AB och Meta är gemensamt personuppgiftsansvariga för insamlingen och överföringen till Meta; Meta ansvarar ensamt för sin fortsatta behandling.

Videor från YouTube och Vimeo laddas först när du klickar på **Spela upp video** eller har valt **Tillåt alltid externa videor**. Kartan från Google Maps laddas först när du klickar på **Visa karta**. Då får YouTube eller Google Maps (Google) respektive Vimeo din IP-adress och kan sätta egna cookies.

Du kan när som helst ändra eller återkalla ditt samtycke via länken **Cookieinställningar** längst ner på sidan. En fullständig lista över cookies, vad de gör och hur länge de sparas finns på sidan [Om cookies](/om-cookies).

## 8. Dina rättigheter

Enligt dataskyddsförordningen (GDPR) har du rätt att:

- få veta vilka uppgifter vi behandlar om dig och få en kopia av dem (registerutdrag),
- få felaktiga uppgifter rättade,
- få uppgifter raderade, om vi inte är skyldiga att spara dem (till exempel enligt bokföringslagen),
- begära att behandlingen begränsas,
- få ut uppgifter som du har lämnat till oss i ett maskinläsbart format (dataportabilitet),
- invända mot behandling som grundar sig på vårt berättigade intresse, och alltid mot direktmarknadsföring,
- när som helst återkalla ett samtycke, utan att det påverkar behandling som skett innan.

Kontakta oss på [info@namez.se](mailto:info@namez.se) för att använda dina rättigheter. Vi svarar inom en månad. I komplicerade fall kan tiden förlängas med högst två månader, och då meddelar vi dig.

## 9. Klagomål

Om du anser att vi behandlar dina personuppgifter felaktigt kan du lämna klagomål till Integritetsskyddsmyndigheten (IMY), Box 8114, 104 20 Stockholm, [www.imy.se](https://www.imy.se). Du kan också vända dig till dataskyddsmyndigheten i det EU-land där du bor eller arbetar. Kontakta gärna oss först, så försöker vi lösa det.

## 10. Ändringar

Vi kan komma att uppdatera denna policy, till exempel när vi börjar använda nya tjänster. Den gällande versionen finns alltid på denna sida, med datum för den senaste ändringen.
`;

// plans/namez-legal/privacy.en.md
const PRIVACY_EN = `
# Privacy policy

*Last updated: November 2026*

This privacy policy explains how namez AB processes your personal data when you visit namez.se, shop with us or contact us. We only process the data we need, and we never sell your personal data.

## 1. Controller

namez AB, company reg. no. 559295-1007, Hagavägen 36, 784 40 Borlänge, Sweden, is the controller for the processing of your personal data. Contact: [info@namez.se](mailto:info@namez.se), phone +46 243-33 32 43.

The store is built on the ShopsDoor e-commerce platform, which is also run by namez AB. No other platform provider therefore gets access to your data through the store.

## 2. The data we process

- **Identity and contact details** – name, email address, phone number and delivery and billing address. If you shop as a business, also the company name, company registration number and VAT number.
- **Order details** – what you bought, prices, discount codes, order history, deliveries, returns and complaints.
- **Details for personalised products** – texts, names, dates and images that you enter or upload so that we can make your product.
- **Payment details** – payment method and whether the payment went through. Card and bank details are handled by the payment provider; we never see or store full card numbers.
- **Account details** – if you create a customer account: login details and saved addresses.
- **Communication** – messages to our customer service and, if you have signed up, your newsletter subscription.
- **Customer stories and reviews** – if you have given us permission: your name, your comment, your rating and the image or video you sent in.
- **Technical data** – IP address, browser, device, approximate location and how you use the website, collected through cookies and similar technologies (see section 7).

## 3. Why we process the data and on what legal basis

- Handling, making and delivering your order and handling payment, returns and complaints – *performance of a contract* (Art. 6(1)(b) GDPR).
- Providing your customer account – *performance of a contract*.
- Bookkeeping and other legal obligations, for example under the Swedish Bookkeeping Act and consumer law – *legal obligation* (Art. 6(1)(c)).
- Customer service, preventing fraud and misuse, protecting the website (including through Cloudflare) and establishing, exercising or defending legal claims – *legitimate interest* (Art. 6(1)(f)).
- Newsletters and email marketing – your *consent* (Art. 6(1)(a)) or, where the law allows, our legitimate interest in offering existing customers similar products. You can always opt out via the link in every email.
- Publishing customer stories and reviews with your name, image or video – your *consent*.
- Statistics and analytics (Google Analytics and Microsoft Clarity) and marketing (Meta Pixel and Meta Conversions API) – your *consent* (Art. 6(1)(a) GDPR and Chapter 9, Section 28 of the Swedish Electronic Communications Act).

## 4. How long we keep the data

- Accounting records, such as receipts and invoices, are kept for seven years after the end of the calendar year in which the financial year ended, as required by the Swedish Bookkeeping Act (1999:1078).
- Other order and customer service data, including texts and images for personalised products, are kept for as long as they are needed for the purchase, returns and complaints – normally up to three years from delivery (the period for complaints) and longer only while a case is ongoing.
- Account details are kept until you close your account.
- Marketing data is kept until you withdraw your consent or unsubscribe.
- Customer stories and reviews are shown until you ask us to remove them.
- Cookies are kept for the periods listed on the [About cookies](/om-cookies) page. Microsoft Clarity recordings are kept for up to 30 days, and Google Analytics statistics for up to 14 months.

## 5. Who we share data with

- **Payment providers** – the checkout is provided by Kustom, and invoice and instalment payments are provided by Klarna Bank AB (publ). They process data to carry out the payment and, for invoice and instalments, for identity and credit checks, which may involve an automated decision. Kustom and Klarna are independent controllers for the data they collect in the checkout, under their own privacy policies.
- **Carriers** – name, address, phone number and email address to deliver your parcel and send delivery notifications.
- **IT providers (processors)** – for server hosting and storage, sending emails and protecting the website (Cloudflare). They may only process the data on our instructions.
- **Analytics and advertising partners** – Google (Google Analytics), Microsoft (Clarity) and Meta (Meta Pixel and Conversions API), only if you have consented. See section 7 and the [About cookies](/om-cookies) page.
- **YouTube, Vimeo and Google Maps** – only if you choose to play an external video or show the map (see section 7).
- **Authorities and advisers** – when required by law (for example the Swedish Tax Agency), to protect our legal claims, and our accountant or auditor.

## 6. Transfers outside the EU/EEA

We aim to process data within the EU/EEA. Google, Microsoft, Meta, Vimeo and Cloudflare may transfer data to the USA. The transfer is based on the EU–US Data Privacy Framework (the European Commission's adequacy decision) for the companies certified under it, and otherwise on the European Commission's standard contractual clauses.

## 7. Cookies, statistics and marketing

We use necessary cookies to make the store work, for example for the cart, login, language choice and checkout. They do not require consent. Everything else is only used if you choose **Accept all** in the cookie banner:

- **Google Analytics 4** (Google Ireland Limited; Google LLC, USA) – statistics on how the store is used and which purchases are made. Google does not store IP addresses of visitors in the EU.
- **Microsoft Clarity** (Microsoft Ireland Operations Limited; Microsoft Corporation, USA) – heatmaps and session recordings that show how visitors click, scroll and move around the pages, so that we can fix problems. What you type into forms, personalisation texts, the cart and the checkout are masked, and Clarity is not used on login pages, My account or the order confirmation. Microsoft is also itself responsible for the processing Microsoft carries out for its own purposes.
- **Meta Pixel and Meta Conversions API** (Meta Platforms Ireland Limited; Meta Platforms, Inc., USA) – to measure and improve our ads on Facebook and Instagram. When you buy something, we also send the purchase and your contact details in hashed form from our server to Meta. namez AB and Meta are joint controllers for the collection and transmission to Meta; Meta alone is responsible for its further processing.

Videos from YouTube and Vimeo are only loaded when you click **Play video** or have chosen **Always allow external videos**. The Google Maps map is only loaded when you click **Show map**. YouTube or Google Maps (Google) or Vimeo then receive your IP address and may set their own cookies.

You can change or withdraw your consent at any time via the **Cookie settings** link at the bottom of the page. A full list of cookies, what they do and how long they are kept is on the [About cookies](/om-cookies) page.

## 8. Your rights

Under the General Data Protection Regulation (GDPR) you have the right to:

- know which data we process about you and get a copy of it (right of access),
- have incorrect data corrected,
- have data erased, unless we are required to keep it (for example under the Bookkeeping Act),
- ask us to restrict the processing,
- receive data you have given us in a machine-readable format (data portability),
- object to processing based on our legitimate interest, and always to direct marketing,
- withdraw a consent at any time, without affecting processing carried out before.

Contact us at [info@namez.se](mailto:info@namez.se) to exercise your rights. We reply within one month. In complex cases this can be extended by up to two more months, and we will then let you know.

## 9. Complaints

If you believe we process your personal data incorrectly, you can lodge a complaint with the Swedish Authority for Privacy Protection (Integritetsskyddsmyndigheten, IMY), Box 8114, 104 20 Stockholm, [www.imy.se](https://www.imy.se). You can also contact the data protection authority in the EU country where you live or work. Feel free to contact us first, and we will try to resolve it.

## 10. Changes

We may update this policy, for example when we start using new services. The current version is always on this page, with the date of the latest change.
`;

/* ------------------------------------------------------------------ */
/* Markdown subset -> HTML                                              */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** **bold**, *em* and [text](url) on already escaped text. */
function inline(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    const external = /^https?:\/\//.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${href}"${attrs}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

/**
 * The subset the source files use: `# ` title (returned, not rendered),
 * `## ` / `### ` headings, `- ` list items, paragraphs separated by a blank
 * line. Anything else is a bug in the source text.
 */
function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = null;
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flushPara();
      flushList();
    } else if (t.startsWith('# ')) {
      flushPara();
      flushList();
      title = t.slice(2).trim();
    } else if (t.startsWith('### ')) {
      flushPara();
      flushList();
      out.push(`<h3>${inline(t.slice(4))}</h3>`);
    } else if (t.startsWith('## ')) {
      flushPara();
      flushList();
      out.push(`<h2>${inline(t.slice(3))}</h2>`);
    } else if (t.startsWith('- ')) {
      flushPara();
      (list = list || []).push(t.slice(2));
    } else if (list) {
      // Continuation line of the last list item.
      list[list.length - 1] += ` ${t}`;
    } else {
      para.push(t);
    }
  }
  flushPara();
  flushList();
  if (!title) throw new Error('Source text has no "# " title line');
  return { title, html: out.join('\n') };
}

const DOCS = {
  cookies: { sv: markdownToHtml(COOKIES_SV), en: markdownToHtml(COOKIES_EN) },
  privacy: { sv: markdownToHtml(PRIVACY_SV), en: markdownToHtml(PRIVACY_EN) },
};

/** `sv-SE` -> `sv`. */
function baseLocale(locale) {
  return String(locale || '').toLowerCase().split(/[-_]/)[0];
}

/** Swedish for Swedish locales, English for every other store locale. */
function langFor(locale) {
  return baseLocale(locale) === 'sv' ? 'sv' : 'en';
}

/* ------------------------------------------------------------------ */
/* Snapshot (same shape as pages-v2 buildPageSnapshot, mode 'publish')  */
/* ------------------------------------------------------------------ */

function bySectionReadOrder(a, b) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  const ca = new Date(a.created_at).getTime();
  const cb = new Date(b.created_at).getTime();
  if (ca !== cb) return ca - cb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Visible sections in depth-first tree order (hidden subtrees dropped). */
function visibleTree(sections) {
  const children = new Map();
  for (const s of sections) {
    const key = s.parent_id || null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(s);
  }
  const out = [];
  const walk = (parentId) => {
    for (const s of (children.get(parentId) || []).slice().sort(bySectionReadOrder)) {
      if (s.is_hidden) continue;
      out.push(s);
      walk(s.id);
    }
  };
  walk(null);
  return out;
}

function buildSnapshot(page) {
  return {
    page: {
      type: page.type,
      static_kind: page.static_kind,
      slug: page.slug,
      seo: page.seo,
      translations: page.translations,
    },
    sections: visibleTree(page.sections).map((s) => ({
      id: s.id,
      parent_id: s.parent_id || null,
      section_key: s.section_key,
      settings: s.settings,
      sort_order: s.sort_order,
      translations: s.translations.map((t) => ({ locale: t.locale, content: t.content })),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Database helpers                                                     */
/* ------------------------------------------------------------------ */

const prisma = new PrismaClient();

const PAGE_INCLUDE = {
  translations: true,
  sections: { include: { translations: true } },
  versions: { select: { id: true, label: true, published_at: true }, orderBy: { created_at: 'desc' }, take: 5 },
  published_version: { select: { id: true, label: true, snapshot: true } },
};

/** JSON with object keys sorted at every level (jsonb does not keep key order). */
function stableStringify(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const byLocale = (a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0);

/** Snapshot reduced to what the storefront renders (no row ids / timestamps of page translations). */
function comparable(snapshot) {
  const page = snapshot.page || {};
  return {
    page: {
      slug: page.slug ?? null,
      seo: page.seo ?? null,
      translations: (page.translations || [])
        // eslint-disable-next-line no-unused-vars
        .map(({ id, page_id, created_at, updated_at, ...rest }) => rest)
        .sort(byLocale),
    },
    sections: new Map(
      (snapshot.sections || []).map((s) => [
        s.id,
        {
          parent_id: s.parent_id || null,
          section_key: s.section_key,
          settings: s.settings ?? null,
          sort_order: s.sort_order,
          translations: (s.translations || []).map((t) => ({ locale: t.locale, content: t.content })).sort(byLocale),
        },
      ]),
    ),
  };
}

/**
 * Differences between the page's current draft (as it would be published)
 * and its published version, before this script changes anything. Empty when
 * they match (or when there is no page yet).
 */
function draftDiff(page) {
  if (!page) return [];
  const draft = comparable(buildSnapshot(page));
  if (!page.published_version) {
    const visible = draft.sections.size;
    return visible || page.translations.length
      ? [`never published: publishing makes its draft live (${visible} visible section(s))`]
      : [];
  }
  const live = comparable(page.published_version.snapshot || {});
  const out = [];
  for (const key of ['slug', 'seo', 'translations']) {
    if (stableStringify(draft.page[key]) !== stableStringify(live.page[key])) out.push(`page ${key} differs`);
  }
  for (const [id, s] of draft.sections) {
    const l = live.sections.get(id);
    if (!l) {
      out.push(`section ${s.section_key} ${id} is visible in the draft but not published`);
      continue;
    }
    const changed = ['parent_id', 'section_key', 'settings', 'sort_order', 'translations'].filter(
      (k) => stableStringify(s[k]) !== stableStringify(l[k]),
    );
    if (changed.length) out.push(`section ${s.section_key} ${id}: ${changed.join(', ')} differ`);
  }
  for (const [id, l] of live.sections) {
    if (!draft.sections.has(id)) out.push(`section ${l.section_key} ${id} is published but hidden or deleted in the draft`);
  }
  return out;
}

/** Prints the draft-vs-published report; returns true when the page has unpublished edits. */
function reportDraftDiff(page) {
  const diff = draftDiff(page);
  if (!diff.length) {
    if (page) console.log('  Draft matches the published version.');
    return false;
  }
  console.log('  WARNING: unpublished builder edits (they would be published too):');
  for (const d of diff) console.log(`    - ${d}`);
  return true;
}

function describeSections(page) {
  for (const s of page.sections.slice().sort(bySectionReadOrder)) {
    console.log(
      `    #${s.sort_order} ${s.section_key}${s.is_hidden ? ' (hidden)' : ''}` +
        `${s.parent_id ? ` parent=${s.parent_id}` : ''} locales=[${s.translations.map((t) => t.locale).join(',')}] id=${s.id}`,
    );
  }
}

async function hasLabel(pageId, label) {
  if (!pageId) return false;
  const v = await prisma.pageVersion.findFirst({ where: { page_id: pageId, label }, select: { id: true } });
  return Boolean(v);
}

/** First free root slug: `base`, `base-2`, ... (v2 pages and legacy pages). */
async function freeSlug(storeId, base) {
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const [v2, legacy] = await Promise.all([
      prisma.page.findFirst({ where: { store_id: storeId, slug }, select: { id: true } }),
      prisma.staticPage.findFirst({ where: { store_id: storeId, slug }, select: { id: true } }),
    ]);
    if (!v2 && !legacy) return slug;
  }
  throw new Error(`No free slug for ${base}`);
}

async function revalidate(slug) {
  const base = process.env.STOREFRONT_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!base || !secret) {
    console.log('Revalidation skipped (STOREFRONT_URL / REVALIDATE_SECRET not set).');
    return;
  }
  try {
    const res = await fetch(`${base}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
      body: JSON.stringify({ slug }),
    });
    console.log(`Revalidation: HTTP ${res.status}`);
  } catch (err) {
    console.log(`Revalidation failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Plans                                                                */
/* ------------------------------------------------------------------ */

/**
 * Cookie page: hide the visible root rich-text section(s) and put one new
 * rich-text section where the first one was (later root siblings move down
 * by one). The hero banner keeps the page H1.
 */
function planCookies(page, locales) {
  const roots = page.sections.filter((s) => !s.parent_id).sort(bySectionReadOrder);
  const visibleRich = roots.filter((s) => !s.is_hidden && s.section_key === 'rich-text');
  const nested = page.sections.filter((s) => s.parent_id && !s.is_hidden && s.section_key === 'rich-text');
  if (nested.length) {
    throw new Error(
      `/${COOKIE_PAGE_SLUG} has rich-text inside a layout container (${nested.map((s) => s.id).join(', ')}); ` +
        'edit it in the builder instead.',
    );
  }
  const maxSort = roots.reduce((m, s) => Math.max(m, s.sort_order), -1);
  const insertAt = visibleRich.length ? visibleRich[0].sort_order : maxSort + 1;
  const settings = visibleRich.length
    ? { ...(visibleRich[0].settings || {}) }
    : { width: 'normal' };
  // The new body is static text even if the old section read product data.
  delete settings.content_source;
  // Everything from the first rich-text on (read order) moves down by one;
  // an earlier section tied on sort_order stays first (older created_at).
  const firstIdx = visibleRich.length ? roots.indexOf(visibleRich[0]) : roots.length;
  return {
    hide: visibleRich.map((s) => s.id),
    shift: roots.slice(firstIdx).map((s) => s.id),
    insertAt,
    settings,
    contents: locales.map((locale) => ({ locale, content: { html: DOCS.cookies[langFor(locale)].html } })),
  };
}

/** Privacy page: hide every visible root section, add the policy as one rich-text section with the H1. */
function planPrivacy(page, locales) {
  const roots = page ? page.sections.filter((s) => !s.parent_id) : [];
  const maxSort = roots.reduce((m, s) => Math.max(m, s.sort_order), -1);
  return {
    hide: roots.filter((s) => !s.is_hidden).map((s) => s.id),
    shift: [],
    insertAt: maxSort + 1,
    settings: { width: 'normal', heading_level: 'h1' },
    contents: locales.map((locale) => {
      const doc = DOCS.privacy[langFor(locale)];
      return { locale, content: { heading: doc.title, html: doc.html } };
    }),
  };
}

async function applyPlan(tx, pageId, plan) {
  if (plan.hide.length) {
    await tx.pageSection.updateMany({ where: { id: { in: plan.hide } }, data: { is_hidden: true } });
  }
  if (plan.shift.length) {
    await tx.pageSection.updateMany({ where: { id: { in: plan.shift } }, data: { sort_order: { increment: 1 } } });
  }
  await tx.pageSection.create({
    data: {
      page_id: pageId,
      section_key: 'rich-text',
      settings: plan.settings,
      sort_order: plan.insertAt,
      translations: { create: plan.contents },
    },
  });
}

/** Title (only when `title` is given or the row is new) + meta description per locale. */
async function upsertTranslations(tx, pageId, locales, kind, { setTitle }) {
  for (const locale of locales) {
    const lang = langFor(locale);
    const title = DOCS[kind][lang].title;
    const meta = META[kind][lang];
    await tx.pageTranslation.upsert({
      where: { page_id_locale: { page_id: pageId, locale } },
      create: { page_id: pageId, locale, title, meta_description: meta },
      update: setTitle ? { title, meta_description: meta } : { meta_description: meta },
    });
  }
}

async function publish(tx, pageId, label) {
  const fresh = await tx.page.findUniqueOrThrow({
    where: { id: pageId },
    include: { translations: true, sections: { include: { translations: true } } },
  });
  const version = await tx.pageVersion.create({
    data: { page_id: pageId, label, snapshot: buildSnapshot(fresh), published_at: new Date() },
  });
  await tx.page.update({ where: { id: pageId }, data: { status: 'PUBLISHED', published_version_id: version.id } });
  return version.id;
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

(async () => {
  try {
    for (const [kind, docs] of Object.entries(DOCS)) {
      for (const [lang, doc] of Object.entries(docs)) {
        console.log(`Text ${kind}.${lang}: "${doc.title}", ${doc.html.length} chars of HTML`);
        if (PRINT_HTML) console.log(`----- ${kind}.${lang} -----\n${doc.html}\n`);
      }
    }

    const store = await prisma.store.findUnique({ where: { slug: STORE_SLUG }, select: { id: true, slug: true } });
    if (!store) throw new Error(`Store ${STORE_SLUG} not found`);
    const lang = await prisma.storeLanguageConfig.findFirst({
      where: { store_id: store.id },
      select: { primary_locale: true, secondary_locales: true },
    });
    const primary = lang?.primary_locale || 'en';
    const locales = [primary, ...((lang?.secondary_locales || []).filter((l) => l && l !== primary))];
    console.log(`Store ${store.slug} (${store.id}), locales [${locales.join(',')}]`);
    console.log(`  text per locale: ${locales.map((l) => `${l}=${langFor(l)}`).join(', ')}`);
    if (langFor(primary) !== 'sv') console.log('  WARNING: the primary locale is not Swedish.');

    // ── Cookie page ──
    const cookiePage = await prisma.page.findFirst({
      where: { store_id: store.id, slug: COOKIE_PAGE_SLUG, type: { in: ['STATIC', 'LANDING'] } },
      include: PAGE_INCLUDE,
    });
    if (!cookiePage) throw new Error(`v2 page /${COOKIE_PAGE_SLUG} not found`);
    console.log(
      `\n/${COOKIE_PAGE_SLUG}: page ${cookiePage.id} (${cookiePage.type}, ${cookiePage.static_kind || '-'}, ${cookiePage.status})`,
    );
    describeSections(cookiePage);
    let unpublishedEdits = false;
    const cookiesDone = await hasLabel(cookiePage.id, COOKIE_LABEL);
    let cookiePlan = null;
    if (cookiesDone) {
      console.log('  Already done by this script; skipped.');
    } else {
      cookiePlan = planCookies(cookiePage, locales);
      if (reportDraftDiff(cookiePage)) unpublishedEdits = true;
      console.log(`  Will hide ${cookiePlan.hide.length} rich-text section(s): ${cookiePlan.hide.join(', ') || '-'}`);
      console.log(`  Will add 1 rich-text section at sort_order ${cookiePlan.insertAt} (${cookiePlan.shift.length} root section(s) move down by one)`);
      console.log(`  Will set meta descriptions for [${locales.join(',')}] and publish "${COOKIE_LABEL}"`);
    }

    // ── Privacy page ──
    const privacyPage = await prisma.page.findFirst({
      where: { store_id: store.id, type: 'STATIC', static_kind: 'PRIVACY_POLICY' },
      include: PAGE_INCLUDE,
    });
    const legacyPrivacy = await prisma.staticPage.findMany({
      where: { store_id: store.id, type: 'PRIVACY_POLICY' },
      select: { id: true, slug: true, status: true },
    });
    console.log(
      `\nPrivacy policy: ${privacyPage ? `v2 page ${privacyPage.id} /${privacyPage.slug} (${privacyPage.status})` : 'no v2 page yet'}` +
        `; legacy pages: ${legacyPrivacy.map((p) => `${p.slug} (${p.status})`).join(', ') || 'none'}`,
    );
    if (privacyPage && privacyPage.id === cookiePage.id) {
      throw new Error(`/${COOKIE_PAGE_SLUG} is itself the PRIVACY_POLICY page; sort this out in the builder first.`);
    }
    if (privacyPage) describeSections(privacyPage);
    const privacyDone = await hasLabel(privacyPage?.id, PRIVACY_LABEL);
    let privacyPlan = null;
    let privacySlug = privacyPage?.slug || null;
    if (privacyDone) {
      console.log('  Already done by this script; skipped.');
    } else {
      privacyPlan = planPrivacy(privacyPage, locales);
      if (reportDraftDiff(privacyPage)) unpublishedEdits = true;
      if (!privacySlug) privacySlug = await freeSlug(store.id, PRIVACY_PAGE_SLUG);
      console.log(
        privacyPage
          ? `  Will hide ${privacyPlan.hide.length} section(s) and add the policy as 1 rich-text section`
          : `  Will create v2 STATIC page PRIVACY_POLICY at /${privacySlug} with the policy as 1 rich-text section`,
      );
      if (privacyPage && !privacyPage.slug) console.log(`  Will give the page the slug /${privacySlug}`);
      console.log(`  Will set titles + meta descriptions for [${locales.join(',')}] and publish "${PRIVACY_LABEL}"`);
      console.log('  /legal/privacy then shows this page instead of the default template.');
    }

    if (!cookiePlan && !privacyPlan) {
      console.log('\nNothing to do.');
      return;
    }
    if (unpublishedEdits) {
      console.log(
        PUBLISH_DRAFT_CHANGES
          ? '\n--publish-draft-changes: the unpublished edits above will be published with the legal text.'
          : '\nSTOP: a page has unpublished builder edits (see WARNING above). Publish or discard them in the ' +
              'builder first, or re-run with --publish-draft-changes to publish them together with the legal text.',
      );
    }
    if (!APPLY) {
      console.log('\nDry run. Re-run with --apply to write and publish.');
      return;
    }
    if (unpublishedEdits && !PUBLISH_DRAFT_CHANGES) {
      process.exitCode = 1;
      return;
    }

    // Backup of the current rows next to the script output.
    const backupFile = path.resolve(`namez-cookie-privacy-backup-${new Date().toISOString().replace(/[:.]/g, '')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ cookiePage, privacyPage, legacyPrivacy }, null, 2));
    console.log(`\nBackup written: ${backupFile}`);

    await prisma.$transaction(
      async (tx) => {
        if (cookiePlan) {
          await applyPlan(tx, cookiePage.id, cookiePlan);
          await upsertTranslations(tx, cookiePage.id, locales, 'cookies', { setTitle: false });
          const v = await publish(tx, cookiePage.id, COOKIE_LABEL);
          console.log(`/${COOKIE_PAGE_SLUG}: published version ${v}`);
        }
        if (privacyPlan) {
          let pageId = privacyPage?.id;
          if (!pageId) {
            const created = await tx.page.create({
              data: {
                store_id: store.id,
                type: 'STATIC',
                static_kind: 'PRIVACY_POLICY',
                slug: privacySlug,
                status: 'DRAFT',
              },
              select: { id: true },
            });
            pageId = created.id;
          } else if (!privacyPage.slug) {
            await tx.page.update({ where: { id: pageId }, data: { slug: privacySlug } });
          }
          await applyPlan(tx, pageId, privacyPlan);
          await upsertTranslations(tx, pageId, locales, 'privacy', { setTitle: true });
          const v = await publish(tx, pageId, PRIVACY_LABEL);
          console.log(`Privacy policy /${privacySlug}: published version ${v} (page ${pageId})`);
        }
      },
      { timeout: 30000 },
    );

    await revalidate(store.slug);
    console.log('Done. Check https://namez.se/om-cookies and https://namez.se/legal/privacy');
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
