/**
 * Default legal texts of store storefronts (plans/store-legal-pages/SPEC.md).
 *
 * The seller is the trader in every text. INDEPENDENT stores: the store owner, with ShopsDoor /
 * Namez AB only as the platform provider acting as GDPR processor. MARKETPLACE stores: the trader
 * IS Namez AB (seller of record and controller). `seller.is_independent` / `seller.is_platform`
 * (exactly one is set) select the sentences that differ between the two.
 * Swedish and English are authoritative; de/fr/ar/tr are faithful translations with the same
 * structure.
 *
 * Placeholders are filled by fillStoreTemplate(); optional values (org_number, address, vat_number,
 * phone) are only used inside <span data-if="..."> so the sentence still reads fine when the value
 * is empty. legal_name falls back to the store name, so it is never empty.
 * The privacy cookie section names a tracking vendor only when the store has it configured:
 * `tracking.ga4`, `tracking.meta`, `tracking.tiktok`, `tracking.clarity` ('1' when the id is
 * set) and `tracking.any` (at least one of them) gate those paragraphs. Their intro sentence is
 * `tracking.gated` (every listed vendor waits for consent to its category: Analytics for GA4 /
 * Clarity, Marketing for Meta / TikTok) or `tracking.ungated` (the store turned consent_required
 * off, so GA4 / Meta / TikTok load on visit; Clarity still waits for Analytics).
 * `tracking.analytics` / `tracking.marketing` are set when that consent category is offered and
 * gated (consent v2). The external-media, consent-storage/log and third-party-cookie paragraphs
 * are unconditional (every store has the external-media category and logs its decisions);
 * `{{store.slug}}` names the `consent:<slug>` storage entry and the `consent_<slug>` cookie.
 * Allowed markup: h2, h3, p, ul, ol, li, strong, em, a. No h1 (the page renders the title).
 * Store-internal links point to the store's own /legal/{slug} pages.
 */
export type StoreLegalSlug = 'privacy' | 'terms' | 'refund' | 'shipping';
export type TemplateLocale = 'sv' | 'en' | 'de' | 'fr' | 'ar' | 'tr';
export interface StoreLegalTemplate {
  title: string;
  html: string;
}

type LocalizedTemplates = Partial<Record<TemplateLocale, StoreLegalTemplate>>;

/* ------------------------------------------------------------------ */
/* Privacy policy                                                      */
/* ------------------------------------------------------------------ */

const PRIVACY: LocalizedTemplates = {
  sv: {
    title: 'Integritetspolicy',
    html: `
<p>I denna integritetspolicy beskriver vi hur {{trader.legal_name}} behandlar personuppgifter när du besöker {{store.name}} ({{store.url}}) eller handlar hos oss.</p>
<h2>1. Personuppgiftsansvarig</h2>
<p>{{trader.legal_name}}<span data-if="trader.org_number">, org.nr {{trader.org_number}}</span><span data-if="trader.address">, {{trader.address}}</span>, är personuppgiftsansvarig för behandlingen av dina personuppgifter. Kontakt: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone">, telefon {{trader.phone}}</span>.</p>
<h2>2. Vilka uppgifter vi behandlar</h2>
<ul>
<li><strong>Identitets- och kontaktuppgifter</strong> – namn, e-postadress, telefonnummer samt leverans- och faktureringsadress.</li>
<li><strong>Orderuppgifter</strong> – vad du har köpt, priser, orderhistorik, returer och reklamationer.</li>
<li><strong>Betalningsuppgifter</strong> – betalsätt och transaktionsstatus. Kortuppgifter hanteras av betaltjänstleverantören; vi ser eller sparar aldrig fullständiga kortnummer.</li>
<li><strong>Kontouppgifter</strong> – om du skapar ett konto: inloggningsuppgifter och sparade inställningar.</li>
<li><strong>Kommunikation</strong> – meddelanden du skickar till oss och, om du har anmält dig, prenumeration på nyhetsbrev.</li>
<li><strong>Tekniska uppgifter</strong> – IP-adress, webbläsare, enhet och hur du använder webbplatsen, som samlas in via cookies och liknande tekniker (se avsnitt 7).</li>
</ul>
<h2>3. Ändamål och rättslig grund</h2>
<ul>
<li>Hantera och leverera din beställning, betalning, retur och reklamation – <em>fullgörande av avtal</em> (art. 6.1 b GDPR).</li>
<li>Tillhandahålla ditt kundkonto – <em>fullgörande av avtal</em>.</li>
<li>Bokföring och andra skyldigheter enligt lag, till exempel bokföringslagen och konsumentlagstiftningen – <em>rättslig förpliktelse</em> (art. 6.1 c).</li>
<li>Kundservice, att förebygga bedrägerier och missbruk, att skydda webbplatsen samt att fastställa, göra gällande eller försvara rättsliga anspråk – <em>berättigat intresse</em> (art. 6.1 f).</li>
<li>Nyhetsbrev och marknadsföring via e-post – ditt <em>samtycke</em> (art. 6.1 a) eller, där lagen tillåter det, vårt berättigade intresse av att erbjuda befintliga kunder liknande produkter. Du kan när som helst tacka nej.</li>
<li>Cookies för analys och marknadsföring – ditt <em>samtycke</em>.</li>
</ul>
<h2>4. Hur länge vi sparar uppgifterna</h2>
<ul>
<li>Räkenskapsinformation, till exempel kvitton och fakturor, sparas i sju år efter utgången av det kalenderår då räkenskapsåret avslutades, enligt bokföringslagen (1999:1078).</li>
<li>Övriga order- och kundtjänstuppgifter sparas så länge de behövs för köpet, returer och reklamationer – normalt i upp till tre år från leveransen (reklamationsfristen) och längre endast om ett ärende pågår.</li>
<li>Kontouppgifter sparas tills du avslutar ditt konto.</li>
<li>Uppgifter för marknadsföring sparas tills du återkallar ditt samtycke eller avregistrerar dig.</li>
</ul>
<h2>5. Vilka vi delar uppgifter med</h2>
<p>Vi säljer aldrig dina personuppgifter. Vi delar dem endast när det behövs:</p>
<ul>
<li><span data-if="seller.is_independent"><strong>Plattformsleverantör (personuppgiftsbiträde)</strong> – butiken drivs på e-handelsplattformen ShopsDoor, som tillhandahålls av Namez AB, org.nr 559295-1007, Hagavägen 36, 784 40 Borlänge. Namez AB driver den tekniska plattformen för butiken och behandlar personuppgifter för vår räkning som vårt personuppgiftsbiträde enligt ett personuppgiftsbiträdesavtal och får inte använda uppgifterna för egna ändamål.</span><span data-if="seller.is_platform"><strong>Plattformen</strong> – butiken drivs på e-handelsplattformen ShopsDoor av Namez AB, som är säljare och personuppgiftsansvarig. Butikens skapare presenterar produkterna. De uppgifter som behövs för leveransen delas med den leverantör som skickar din beställning.</span></li>
<li><span data-if="seller.is_independent"><strong>Underbiträden</strong></span><span data-if="seller.is_platform"><strong>Personuppgiftsbiträden</strong></span> – Namez AB anlitar underleverantörer för drift och lagring på servrar inom EU/EES, e-postutskick och liknande tekniska tjänster.</li>
<li><strong>Betaltjänstleverantörer</strong> – beroende på vilket betalsätt du väljer: Stripe, Kustom (kassan) och Klarna (faktura och delbetalning). De behandlar uppgifter för att genomföra betalningen. Kustom och Klarna är självständigt personuppgiftsansvariga för de uppgifter de samlar in i kassan och vid kreditprövning, enligt sina egna integritetspolicyer; Stripe även för bedrägeriförebyggande och regelefterlevnad.</li>
<li><strong>Transportföretag</strong> – namn, adress och kontaktuppgifter för att leverera ditt paket och skicka leveransaviseringar.</li>
<li><strong>Myndigheter och rådgivare</strong> – när lagen kräver det (till exempel Skatteverket), för att tillvarata våra rättsliga anspråk, samt till vår redovisningskonsult eller revisor.</li>
</ul>
<h2>6. Överföring utanför EU/EES</h2>
<p>Vi strävar efter att behandla uppgifter inom EU/EES. Om en leverantör behandlar uppgifter utanför EU/EES, till exempel i USA, sker överföringen med stöd av ett beslut om adekvat skyddsnivå (såsom EU–US Data Privacy Framework) eller EU-kommissionens standardavtalsklausuler.</p>
<h2>7. Cookies</h2>
<p>Vi använder nödvändiga cookies och liknande tekniker för att butiken ska fungera, till exempel för att komma ihåg din varukorg, hålla dig inloggad, spara ditt val av språk och valuta och skydda kassan. Dessa kräver inte samtycke. Cookies för analys eller marknadsföring används endast om du har samtyckt till det. Du kan när som helst ändra ditt val via länken Cookieinställningar längst ner på sidan, eller radera cookies i din webbläsare.</p>
<p><span data-if="tracking.gated">Om du samtycker använder vi följande tjänster för statistik och marknadsföring. Tjänsterna för statistik laddas bara om du godkänner Statistik, och tjänsterna för marknadsföring bara om du godkänner Marknadsföring, i cookiebannern eller under Cookieinställningar. De slutar användas när du återkallar ditt samtycke:</span><span data-if="tracking.ungated">Vi använder följande tjänster för analys och marknadsföring. Google Analytics, Meta Pixel och TikTok Pixel, i den mån de anges nedan, laddas när du besöker butiken. Microsoft Clarity, om den anges nedan, laddas bara om du godkänner Statistik i cookiebannern eller under Cookieinställningar, och slutar användas när du återkallar ditt samtycke:</span></p>
<p><span data-if="tracking.ga4"><strong>Google Analytics</strong> (Google Ireland Ltd; Google LLC, USA) – statistik över hur butiken används (besökta sidor, enhet, ungefärlig plats). Cookies: <em>_ga</em> och <em>_ga_*</em>, upp till 2 år. Se <a href="https://policies.google.com/privacy">Googles integritetspolicy</a>.</span></p>
<p><span data-if="tracking.meta"><strong>Meta Pixel</strong> (Meta Platforms Ireland Ltd; Meta Platforms, Inc., USA) – för att mäta och förbättra våra annonser på Facebook och Instagram. Cookies: <em>_fbp</em> och <em>_fbc</em>, upp till 90 dagar. Vi och Meta är gemensamt ansvariga för insamlingen och överföringen av uppgifterna; Meta ansvarar för sin fortsatta behandling. Se <a href="https://www.facebook.com/privacy/policy/">Metas integritetspolicy</a>.</span></p>
<p><span data-if="tracking.tiktok"><strong>TikTok Pixel</strong> (TikTok Technology Ltd, Irland) – för att mäta och förbättra våra annonser på TikTok. Cookie: <em>_ttp</em>, cirka 13 månader. Se <a href="https://www.tiktok.com/legal/page/eea/privacy-policy/en">TikToks integritetspolicy</a>.</span></p>
<p><span data-if="tracking.clarity"><strong>Microsoft Clarity</strong> (Microsoft Ireland Operations Ltd; Microsoft Corporation, USA) – värmekartor (heatmaps) och sessionsinspelningar som visar hur besökare använder butiken (klick, skrollning, musrörelser, besökta sidor, enhet och webbläsare), så att vi kan hitta och åtgärda problem. Text som du skriver i formulär, personliga texter och kassan maskeras i inspelningarna, och betaluppgifter spelas aldrig in. Cookies: <em>_clck</em> (cirka 1 år) och <em>_clsk</em> (cirka 1 dag). Microsoft kan även sätta egna cookies (till exempel <em>MUID</em>) som vi inte kan radera åt dig. Inspelningar sparas i upp till 30 dagar och ett urval av dem i upp till 9 månader. Microsoft behandlar även uppgifterna för egna ändamål enligt <a href="https://privacy.microsoft.com/privacystatement">Microsofts integritetspolicy</a>.</span></p>
<p><span data-if="tracking.any">Dessa leverantörer kan överföra uppgifter till USA. Överföringen sker med stöd av EU–US Data Privacy Framework eller EU-kommissionens standardavtalsklausuler.</span></p>
<p><strong>Externa medier (YouTube, Vimeo, Google Maps)</strong> – videor från YouTube eller Vimeo och kartor från Google Maps på butikens sidor visas först när du godkänner Externa medier i cookiebannern eller under Cookieinställningar, eller när du väljer att visa just det innehållet. Då ansluter din webbläsare till leverantören, som kan sätta egna cookies och få uppgifter om ditt besök, till exempel din IP-adress, och som behandlar dem enligt sin egen integritetspolicy.</p>
<p>Ditt cookieval sparas i din webbläsare tillsammans med ett slumpmässigt samtyckes-ID, i localStorage-posten <em>consent:{{store.slug}}</em> och i cookien <em>consent_{{store.slug}}</em> (12 månader). Efter 12 månader frågar vi dig igen. För att kunna visa att du har lämnat eller nekat samtycke sparar vi varje val i en samtyckeslogg: samtyckes-ID:t, vilka kategorier du valde, tidpunkten, språket och en kontrollsumma av texten du fick se, samt en förkortad IP-adress och en kontrollsumma av webbläsarens identifiering (user agent), men aldrig din fullständiga IP-adress. Loggen sparas i 24 månader. Ditt samtyckes-ID visas under Cookieinställningar.</p>
<p>Tredjepartscookies från Microsoft (<em>MUID</em>, <em>CLID</em>) och Google/YouTube kan inte raderas av butiken när du återkallar ditt samtycke; du kan ta bort dem i webbläsaren.</p>
<h2>8. Dina rättigheter</h2>
<p>Enligt dataskyddsförordningen (GDPR) har du rätt att:</p>
<ul>
<li>få information om och tillgång till de uppgifter vi behandlar om dig (registerutdrag),</li>
<li>få felaktiga uppgifter rättade,</li>
<li>få uppgifter raderade, om vi inte är skyldiga att spara dem (till exempel enligt bokföringslagen),</li>
<li>begära att behandlingen begränsas,</li>
<li>få ut uppgifter som du har lämnat i ett maskinläsbart format (dataportabilitet),</li>
<li>invända mot behandling som grundas på berättigat intresse, och alltid mot direktmarknadsföring,</li>
<li>när som helst återkalla ett samtycke, utan att det påverkar behandling som skett dessförinnan.</li>
</ul>
<p>Kontakta oss på <a href="mailto:{{trader.email}}">{{trader.email}}</a> för att utöva dina rättigheter. Vi svarar inom en månad (i komplicerade fall kan tiden förlängas med högst två månader; då meddelar vi dig).</p>
<h2>9. Klagomål</h2>
<p>Om du anser att vi behandlar dina personuppgifter felaktigt kan du lämna klagomål till Integritetsskyddsmyndigheten (IMY), Box 8114, 104 20 Stockholm, <a href="https://www.imy.se">www.imy.se</a>. Du kan också vända dig till dataskyddsmyndigheten i det EU-land där du bor eller arbetar.</p>
<h2>10. Ändringar</h2>
<p>Vi kan komma att uppdatera denna policy. Den gällande versionen finns alltid på denna sida.</p>
`,
  },
  en: {
    title: 'Privacy Policy',
    html: `
<p>This privacy policy explains how {{trader.legal_name}} processes personal data when you visit {{store.name}} ({{store.url}}) or shop with us.</p>
<h2>1. Controller</h2>
<p>{{trader.legal_name}}<span data-if="trader.org_number">, company reg. no. {{trader.org_number}}</span><span data-if="trader.address">, {{trader.address}}</span>, is the controller of your personal data. Contact: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone">, phone {{trader.phone}}</span>.</p>
<h2>2. What data we process</h2>
<ul>
<li><strong>Identity and contact details</strong> – name, email address, phone number, and delivery and billing address.</li>
<li><strong>Order details</strong> – what you bought, prices, order history, returns and complaints.</li>
<li><strong>Payment details</strong> – payment method and transaction status. Card details are handled by the payment provider; we never see or store full card numbers.</li>
<li><strong>Account details</strong> – if you create an account: login details and saved preferences.</li>
<li><strong>Communication</strong> – messages you send us and, if you sign up, your newsletter subscription.</li>
<li><strong>Technical data</strong> – IP address, browser, device and how you use the website, collected through cookies and similar technologies (see section 7).</li>
</ul>
<h2>3. Purposes and legal bases</h2>
<ul>
<li>Handling and delivering your order, payment, returns and complaints – <em>performance of a contract</em> (Art. 6(1)(b) GDPR).</li>
<li>Providing your customer account – <em>performance of a contract</em>.</li>
<li>Bookkeeping and other legal obligations, for example under the Swedish Accounting Act and consumer law – <em>legal obligation</em> (Art. 6(1)(c)).</li>
<li>Customer service, preventing fraud and misuse, securing the website, and establishing, exercising or defending legal claims – <em>legitimate interests</em> (Art. 6(1)(f)).</li>
<li>Newsletters and email marketing – your <em>consent</em> (Art. 6(1)(a)) or, where the law allows it, our legitimate interest in offering similar products to existing customers. You can opt out at any time.</li>
<li>Analytics and marketing cookies – your <em>consent</em>.</li>
</ul>
<h2>4. How long we keep data</h2>
<ul>
<li>Accounting records, such as receipts and invoices, are kept for seven years after the end of the calendar year in which the financial year ended, as required by the Swedish Accounting Act (bokföringslagen, 1999:1078).</li>
<li>Other order and customer service data is kept as long as needed for the purchase, returns and complaints – normally up to three years from delivery (the complaint period), and longer only while a case is ongoing.</li>
<li>Account data is kept until you close your account.</li>
<li>Marketing data is kept until you withdraw your consent or unsubscribe.</li>
</ul>
<h2>5. Who we share data with</h2>
<p>We never sell your personal data. We only share it where necessary:</p>
<ul>
<li><span data-if="seller.is_independent"><strong>Platform provider (processor)</strong> – the store runs on the e-commerce platform ShopsDoor, provided by Namez AB, company reg. no. 559295-1007, Hagavägen 36, 784 40 Borlänge, Sweden. Namez AB operates the technical platform for the store and processes personal data on our behalf as our processor (personuppgiftsbiträde) under a data processing agreement, and may not use the data for its own purposes.</span><span data-if="seller.is_platform"><strong>Platform</strong> – the store is operated on the e-commerce platform ShopsDoor by Namez AB, which is the seller and the controller. The store’s creator presents the products. The details needed for delivery are shared with the supplier that ships your order.</span></li>
<li><span data-if="seller.is_independent"><strong>Sub-processors</strong></span><span data-if="seller.is_platform"><strong>Processors</strong></span> – Namez AB uses subcontractors for hosting and storage on servers in the EU/EEA, email delivery and similar technical services.</li>
<li><strong>Payment providers</strong> – depending on the payment method you choose: Stripe, Kustom (checkout) and Klarna (invoice and instalments). They process data to carry out the payment. Kustom and Klarna are independent controllers for the data they collect in the checkout and for credit checks, under their own privacy policies; Stripe also for fraud prevention and regulatory compliance.</li>
<li><strong>Carriers</strong> – name, address and contact details to deliver your parcel and send delivery notifications.</li>
<li><strong>Authorities and advisers</strong> – where required by law (for example the Swedish Tax Agency), to protect our legal claims, and to our accountant or auditor.</li>
</ul>
<h2>6. Transfers outside the EU/EEA</h2>
<p>We aim to process data within the EU/EEA. If a provider processes data outside the EU/EEA, for example in the United States, the transfer is based on an adequacy decision (such as the EU–US Data Privacy Framework) or the European Commission's standard contractual clauses.</p>
<h2>7. Cookies</h2>
<p>We use necessary cookies and similar technologies to make the store work, for example to remember your shopping cart, keep you logged in, save your language and currency choice and protect the checkout. These do not require consent. Cookies for analytics or marketing are only used if you have consented to them. You can change your choice at any time via the Cookie settings link at the bottom of the page, or delete cookies in your browser.</p>
<p><span data-if="tracking.gated">If you consent, we use the following analytics and marketing services. Analytics services load only if you allow Analytics, and marketing services only if you allow Marketing, in the cookie banner or under Cookie settings. They stop being used when you withdraw your consent:</span><span data-if="tracking.ungated">We use the following analytics and marketing services. Google Analytics, Meta Pixel and TikTok Pixel, where listed below, are loaded when you visit the store. Microsoft Clarity, where listed below, loads only if you allow Analytics in the cookie banner or under Cookie settings, and stops being used when you withdraw your consent:</span></p>
<p><span data-if="tracking.ga4"><strong>Google Analytics</strong> (Google Ireland Ltd; Google LLC, USA) – statistics on how the store is used (pages viewed, device, approximate location). Cookies: <em>_ga</em> and <em>_ga_*</em>, up to 2 years. See <a href="https://policies.google.com/privacy">Google’s privacy policy</a>.</span></p>
<p><span data-if="tracking.meta"><strong>Meta Pixel</strong> (Meta Platforms Ireland Ltd; Meta Platforms, Inc., USA) – to measure and improve our ads on Facebook and Instagram. Cookies: <em>_fbp</em> and <em>_fbc</em>, up to 90 days. We and Meta are jointly responsible for collecting and transmitting the data; Meta is responsible for its further processing. See <a href="https://www.facebook.com/privacy/policy/">Meta’s privacy policy</a>.</span></p>
<p><span data-if="tracking.tiktok"><strong>TikTok Pixel</strong> (TikTok Technology Ltd, Ireland) – to measure and improve our ads on TikTok. Cookie: <em>_ttp</em>, about 13 months. See <a href="https://www.tiktok.com/legal/page/eea/privacy-policy/en">TikTok’s privacy policy</a>.</span></p>
<p><span data-if="tracking.clarity"><strong>Microsoft Clarity</strong> (Microsoft Ireland Operations Ltd; Microsoft Corporation, USA) – heatmaps and session recordings that show how visitors use the store (clicks, scrolling, mouse movements, pages visited, device and browser), so we can find and fix problems. Text you type into forms, personalisation texts and the checkout are masked in the recordings, and payment details are never recorded. Cookies: <em>_clck</em> (about 1 year) and <em>_clsk</em> (about 1 day). Microsoft may also set its own cookies (for example <em>MUID</em>), which we cannot delete for you. Recordings are kept for up to 30 days, and a selection of them for up to 9 months. Microsoft also processes the data for its own purposes as described in the <a href="https://privacy.microsoft.com/privacystatement">Microsoft Privacy Statement</a>.</span></p>
<p><span data-if="tracking.any">These providers may transfer data to the United States. The transfer is based on the EU–US Data Privacy Framework or the European Commission’s standard contractual clauses.</span></p>
<p><strong>External media (YouTube, Vimeo, Google Maps)</strong> – videos from YouTube or Vimeo and maps from Google Maps on the store’s pages are shown only once you allow External media in the cookie banner or under Cookie settings, or choose to show that particular item. Your browser then connects to the provider, which may set its own cookies and receive information about your visit, such as your IP address, and processes it under its own privacy policy.</p>
<p>Your cookie choice is stored in your browser together with a random consent ID, in the localStorage entry <em>consent:{{store.slug}}</em> and the cookie <em>consent_{{store.slug}}</em> (12 months). After 12 months we ask you again. To be able to show that you gave or refused consent, we record each choice in a consent log: the consent ID, the categories you chose, the time, the language and a checksum of the text you were shown, plus a shortened IP address and a checksum of your browser’s identification (user agent), but never your full IP address. The log is kept for 24 months. Your consent ID is shown under Cookie settings.</p>
<p>Third-party cookies from Microsoft (<em>MUID</em>, <em>CLID</em>) and Google/YouTube cannot be deleted by the store when you withdraw your consent; you can remove them in your browser.</p>
<h2>8. Your rights</h2>
<p>Under the General Data Protection Regulation (GDPR) you have the right to:</p>
<ul>
<li>be informed about and access the data we process about you,</li>
<li>have inaccurate data corrected,</li>
<li>have data erased, unless we are required to keep it (for example under the Accounting Act),</li>
<li>request that processing is restricted,</li>
<li>receive the data you have provided in a machine-readable format (data portability),</li>
<li>object to processing based on legitimate interests, and always to direct marketing,</li>
<li>withdraw your consent at any time, without affecting processing carried out before.</li>
</ul>
<p>Contact us at <a href="mailto:{{trader.email}}">{{trader.email}}</a> to exercise your rights. We respond within one month (extendable by up to two months for complex requests; we will tell you if so).</p>
<h2>9. Complaints</h2>
<p>If you believe we process your personal data incorrectly, you can lodge a complaint with the Swedish Authority for Privacy Protection (Integritetsskyddsmyndigheten, IMY), Box 8114, 104 20 Stockholm, Sweden, <a href="https://www.imy.se">www.imy.se</a>. You can also contact the data protection authority in the EU country where you live or work.</p>
<h2>10. Changes</h2>
<p>We may update this policy. The current version is always available on this page.</p>
`,
  },
  de: {
    title: 'Datenschutzerklärung',
    html: `
<p>In dieser Datenschutzerklärung erläutern wir, wie {{trader.legal_name}} personenbezogene Daten verarbeitet, wenn Sie {{store.name}} ({{store.url}}) besuchen oder bei uns einkaufen.</p>
<h2>1. Verantwortlicher</h2>
<p>{{trader.legal_name}}<span data-if="trader.org_number">, Org.-Nr. {{trader.org_number}}</span><span data-if="trader.address">, {{trader.address}}</span>, ist Verantwortlicher für die Verarbeitung Ihrer personenbezogenen Daten. Kontakt: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone">, Telefon {{trader.phone}}</span>.</p>
<h2>2. Welche Daten wir verarbeiten</h2>
<ul>
<li><strong>Identitäts- und Kontaktdaten</strong> – Name, E-Mail-Adresse, Telefonnummer sowie Liefer- und Rechnungsadresse.</li>
<li><strong>Bestelldaten</strong> – gekaufte Produkte, Preise, Bestellhistorie, Rücksendungen und Reklamationen.</li>
<li><strong>Zahlungsdaten</strong> – Zahlungsart und Transaktionsstatus. Kartendaten werden vom Zahlungsdienstleister verarbeitet; wir sehen oder speichern niemals vollständige Kartennummern.</li>
<li><strong>Kontodaten</strong> – wenn Sie ein Konto anlegen: Anmeldedaten und gespeicherte Einstellungen.</li>
<li><strong>Kommunikation</strong> – Nachrichten, die Sie uns senden, und, falls Sie sich anmelden, Ihr Newsletter-Abonnement.</li>
<li><strong>Technische Daten</strong> – IP-Adresse, Browser, Gerät und Ihre Nutzung der Website, erhoben über Cookies und ähnliche Technologien (siehe Abschnitt 7).</li>
</ul>
<h2>3. Zwecke und Rechtsgrundlagen</h2>
<ul>
<li>Abwicklung und Lieferung Ihrer Bestellung, Zahlung, Rücksendung und Reklamation – <em>Vertragserfüllung</em> (Art. 6 Abs. 1 lit. b DSGVO).</li>
<li>Bereitstellung Ihres Kundenkontos – <em>Vertragserfüllung</em>.</li>
<li>Buchführung und andere gesetzliche Pflichten, etwa nach dem schwedischen Buchführungsgesetz und dem Verbraucherrecht – <em>rechtliche Verpflichtung</em> (Art. 6 Abs. 1 lit. c).</li>
<li>Kundenservice, Verhinderung von Betrug und Missbrauch, Schutz der Website sowie Geltendmachung, Ausübung oder Verteidigung von Rechtsansprüchen – <em>berechtigte Interessen</em> (Art. 6 Abs. 1 lit. f).</li>
<li>Newsletter und E-Mail-Werbung – Ihre <em>Einwilligung</em> (Art. 6 Abs. 1 lit. a) oder, soweit gesetzlich zulässig, unser berechtigtes Interesse, Bestandskunden ähnliche Produkte anzubieten. Sie können jederzeit widersprechen.</li>
<li>Analyse- und Marketing-Cookies – Ihre <em>Einwilligung</em>.</li>
</ul>
<h2>4. Speicherdauer</h2>
<ul>
<li>Buchhaltungsunterlagen wie Quittungen und Rechnungen werden sieben Jahre nach Ablauf des Kalenderjahres aufbewahrt, in dem das Geschäftsjahr endete, wie es das schwedische Buchführungsgesetz (bokföringslagen, 1999:1078) vorschreibt.</li>
<li>Sonstige Bestell- und Kundenservicedaten werden so lange gespeichert, wie es für den Kauf, Rücksendungen und Reklamationen erforderlich ist – in der Regel bis zu drei Jahre ab Lieferung (Reklamationsfrist) und länger nur, solange ein Vorgang offen ist.</li>
<li>Kontodaten werden gespeichert, bis Sie Ihr Konto schließen.</li>
<li>Marketingdaten werden gespeichert, bis Sie Ihre Einwilligung widerrufen oder sich abmelden.</li>
</ul>
<h2>5. Empfänger der Daten</h2>
<p>Wir verkaufen Ihre personenbezogenen Daten niemals. Wir geben sie nur weiter, soweit dies erforderlich ist:</p>
<ul>
<li><span data-if="seller.is_independent"><strong>Plattformanbieter (Auftragsverarbeiter)</strong> – der Shop läuft auf der E-Commerce-Plattform ShopsDoor, bereitgestellt von Namez AB, Org.-Nr. 559295-1007, Hagavägen 36, 784 40 Borlänge, Schweden. Namez AB betreibt die technische Plattform des Shops und verarbeitet personenbezogene Daten in unserem Auftrag als unser Auftragsverarbeiter (personuppgiftsbiträde) auf Grundlage eines Auftragsverarbeitungsvertrags und darf die Daten nicht für eigene Zwecke nutzen.</span><span data-if="seller.is_platform"><strong>Plattform</strong> – der Shop wird auf der E-Commerce-Plattform ShopsDoor von Namez AB betrieben, die Verkäufer und Verantwortlicher ist. Die Produkte werden von der Person präsentiert, die den Shop erstellt hat. Die für die Lieferung erforderlichen Angaben werden an den Lieferanten weitergegeben, der Ihre Bestellung versendet.</span></li>
<li><span data-if="seller.is_independent"><strong>Unterauftragsverarbeiter</strong></span><span data-if="seller.is_platform"><strong>Auftragsverarbeiter</strong></span> – Namez AB setzt Subunternehmer für Hosting und Speicherung auf Servern in der EU/im EWR, den E-Mail-Versand und ähnliche technische Dienste ein.</li>
<li><strong>Zahlungsdienstleister</strong> – je nach gewählter Zahlungsart: Stripe, Kustom (Checkout) und Klarna (Rechnungs- und Ratenkauf). Sie verarbeiten Daten zur Durchführung der Zahlung. Kustom und Klarna sind für die Daten, die sie im Checkout und bei Bonitätsprüfungen erheben, eigenständige Verantwortliche nach ihren eigenen Datenschutzerklärungen; Stripe auch für Betrugsprävention und die Einhaltung regulatorischer Pflichten.</li>
<li><strong>Versanddienstleister</strong> – Name, Adresse und Kontaktdaten, um Ihr Paket zuzustellen und Versandbenachrichtigungen zu senden.</li>
<li><strong>Behörden und Berater</strong> – soweit gesetzlich vorgeschrieben (z. B. die schwedische Steuerbehörde), zur Wahrung unserer Rechtsansprüche sowie an unseren Steuerberater oder Wirtschaftsprüfer.</li>
</ul>
<h2>6. Übermittlung außerhalb der EU/des EWR</h2>
<p>Wir bemühen uns, Daten innerhalb der EU/des EWR zu verarbeiten. Verarbeitet ein Anbieter Daten außerhalb der EU/des EWR, etwa in den USA, erfolgt die Übermittlung auf Grundlage eines Angemessenheitsbeschlusses (wie dem EU-US Data Privacy Framework) oder der Standardvertragsklauseln der Europäischen Kommission.</p>
<h2>7. Cookies</h2>
<p>Wir verwenden notwendige Cookies und ähnliche Technologien, damit der Shop funktioniert, zum Beispiel um Ihren Warenkorb zu speichern, Sie angemeldet zu halten, Ihre Sprach- und Währungsauswahl zu speichern und den Checkout zu schützen. Diese erfordern keine Einwilligung. Cookies für Analyse oder Marketing werden nur verwendet, wenn Sie eingewilligt haben. Sie können Ihre Wahl jederzeit über den Link „Cookie-Einstellungen“ unten auf der Seite ändern oder Cookies in Ihrem Browser löschen.</p>
<p><span data-if="tracking.gated">Wenn Sie einwilligen, verwenden wir die folgenden Analyse- und Marketingdienste. Statistikdienste werden nur geladen, wenn Sie „Statistik“ zulassen, und Marketingdienste nur, wenn Sie „Marketing“ zulassen – im Cookie-Banner oder unter „Cookie-Einstellungen“. Sie werden nicht mehr verwendet, sobald Sie Ihre Einwilligung widerrufen:</span><span data-if="tracking.ungated">Wir verwenden die folgenden Analyse- und Marketingdienste. Google Analytics, Meta Pixel und TikTok Pixel werden, soweit unten aufgeführt, beim Besuch des Shops geladen. Microsoft Clarity wird, soweit unten aufgeführt, nur geladen, wenn Sie im Cookie-Banner oder unter „Cookie-Einstellungen“ „Statistik“ zulassen, und nicht mehr verwendet, sobald Sie Ihre Einwilligung widerrufen:</span></p>
<p><span data-if="tracking.ga4"><strong>Google Analytics</strong> (Google Ireland Ltd; Google LLC, USA) – Statistiken darüber, wie der Shop genutzt wird (aufgerufene Seiten, Gerät, ungefährer Standort). Cookies: <em>_ga</em> und <em>_ga_*</em>, bis zu 2 Jahre. Siehe <a href="https://policies.google.com/privacy">Datenschutzerklärung von Google</a>.</span></p>
<p><span data-if="tracking.meta"><strong>Meta Pixel</strong> (Meta Platforms Ireland Ltd; Meta Platforms, Inc., USA) – um unsere Anzeigen auf Facebook und Instagram zu messen und zu verbessern. Cookies: <em>_fbp</em> und <em>_fbc</em>, bis zu 90 Tage. Wir und Meta sind gemeinsam verantwortlich für die Erhebung und Übermittlung der Daten; für die weitere Verarbeitung ist Meta verantwortlich. Siehe <a href="https://www.facebook.com/privacy/policy/">Datenschutzrichtlinie von Meta</a>.</span></p>
<p><span data-if="tracking.tiktok"><strong>TikTok Pixel</strong> (TikTok Technology Ltd, Irland) – um unsere Anzeigen auf TikTok zu messen und zu verbessern. Cookie: <em>_ttp</em>, etwa 13 Monate. Siehe <a href="https://www.tiktok.com/legal/page/eea/privacy-policy/en">Datenschutzrichtlinie von TikTok</a>.</span></p>
<p><span data-if="tracking.clarity"><strong>Microsoft Clarity</strong> (Microsoft Ireland Operations Ltd; Microsoft Corporation, USA) – Heatmaps und Sitzungsaufzeichnungen, die zeigen, wie Besucher den Shop nutzen (Klicks, Scrollen, Mausbewegungen, aufgerufene Seiten, Gerät und Browser), damit wir Probleme finden und beheben können. Texte, die Sie in Formulare eingeben, Personalisierungstexte und der Checkout werden in den Aufzeichnungen maskiert; Zahlungsdaten werden nie aufgezeichnet. Cookies: <em>_clck</em> (etwa 1 Jahr) und <em>_clsk</em> (etwa 1 Tag). Microsoft kann außerdem eigene Cookies setzen (zum Beispiel <em>MUID</em>), die wir nicht für Sie löschen können. Aufzeichnungen werden bis zu 30 Tage gespeichert, eine Auswahl davon bis zu 9 Monate. Microsoft verarbeitet die Daten auch für eigene Zwecke, wie in der <a href="https://privacy.microsoft.com/privacystatement">Datenschutzerklärung von Microsoft</a> beschrieben.</span></p>
<p><span data-if="tracking.any">Diese Anbieter können Daten in die USA übermitteln. Die Übermittlung erfolgt auf Grundlage des EU-US Data Privacy Framework oder der Standardvertragsklauseln der Europäischen Kommission.</span></p>
<p><strong>Externe Medien (YouTube, Vimeo, Google Maps)</strong> – Videos von YouTube oder Vimeo und Karten von Google Maps auf den Seiten des Shops werden erst angezeigt, wenn Sie im Cookie-Banner oder unter „Cookie-Einstellungen“ „Externe Medien“ zulassen oder sich für die Anzeige genau dieses Inhalts entscheiden. Ihr Browser verbindet sich dann mit dem Anbieter, der eigene Cookies setzen und Informationen über Ihren Besuch erhalten kann, zum Beispiel Ihre IP-Adresse, und diese nach seiner eigenen Datenschutzerklärung verarbeitet.</p>
<p>Ihre Cookie-Auswahl wird zusammen mit einer zufälligen Einwilligungs-ID in Ihrem Browser gespeichert, im localStorage-Eintrag <em>consent:{{store.slug}}</em> und im Cookie <em>consent_{{store.slug}}</em> (12 Monate). Nach 12 Monaten fragen wir Sie erneut. Damit wir nachweisen können, dass Sie eingewilligt oder abgelehnt haben, speichern wir jede Auswahl in einem Einwilligungsprotokoll: die Einwilligungs-ID, die gewählten Kategorien, den Zeitpunkt, die Sprache und eine Prüfsumme des angezeigten Textes sowie eine gekürzte IP-Adresse und eine Prüfsumme der Browserkennung (User-Agent), aber niemals Ihre vollständige IP-Adresse. Das Protokoll wird 24 Monate aufbewahrt. Ihre Einwilligungs-ID wird unter „Cookie-Einstellungen“ angezeigt.</p>
<p>Drittanbieter-Cookies von Microsoft (<em>MUID</em>, <em>CLID</em>) und Google/YouTube kann der Shop nicht löschen, wenn Sie Ihre Einwilligung widerrufen; Sie können sie in Ihrem Browser entfernen.</p>
<h2>8. Ihre Rechte</h2>
<p>Nach der Datenschutz-Grundverordnung (DSGVO) haben Sie das Recht,</p>
<ul>
<li>Auskunft über die von uns verarbeiteten Daten zu erhalten,</li>
<li>unrichtige Daten berichtigen zu lassen,</li>
<li>Daten löschen zu lassen, sofern wir nicht zur Aufbewahrung verpflichtet sind (z. B. nach dem Buchführungsgesetz),</li>
<li>die Einschränkung der Verarbeitung zu verlangen,</li>
<li>die von Ihnen bereitgestellten Daten in einem maschinenlesbaren Format zu erhalten (Datenübertragbarkeit),</li>
<li>einer Verarbeitung aufgrund berechtigter Interessen und jederzeit der Direktwerbung zu widersprechen,</li>
<li>eine Einwilligung jederzeit zu widerrufen, ohne dass die zuvor erfolgte Verarbeitung berührt wird.</li>
</ul>
<p>Kontaktieren Sie uns unter <a href="mailto:{{trader.email}}">{{trader.email}}</a>, um Ihre Rechte auszuüben. Wir antworten innerhalb eines Monats (bei komplexen Anfragen kann sich die Frist um höchstens zwei Monate verlängern; in diesem Fall informieren wir Sie).</p>
<h2>9. Beschwerden</h2>
<p>Wenn Sie der Meinung sind, dass wir Ihre personenbezogenen Daten unrechtmäßig verarbeiten, können Sie sich bei der schwedischen Datenschutzbehörde (Integritetsskyddsmyndigheten, IMY), Box 8114, 104 20 Stockholm, Schweden, <a href="https://www.imy.se">www.imy.se</a>, beschweren. Sie können sich auch an die Datenschutzbehörde des EU-Landes wenden, in dem Sie wohnen oder arbeiten.</p>
<h2>10. Änderungen</h2>
<p>Wir können diese Erklärung aktualisieren. Die jeweils gültige Fassung finden Sie stets auf dieser Seite.</p>
`,
  },
  fr: {
    title: 'Politique de confidentialité',
    html: `
<p>La présente politique de confidentialité explique comment {{trader.legal_name}} traite les données personnelles lorsque vous visitez {{store.name}} ({{store.url}}) ou effectuez un achat chez nous.</p>
<h2>1. Responsable du traitement</h2>
<p>{{trader.legal_name}}<span data-if="trader.org_number">, numéro d’immatriculation {{trader.org_number}}</span><span data-if="trader.address">, {{trader.address}}</span>, est responsable du traitement de vos données personnelles. Contact : <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone">, téléphone {{trader.phone}}</span>.</p>
<h2>2. Données traitées</h2>
<ul>
<li><strong>Données d’identité et de contact</strong> – nom, adresse e-mail, numéro de téléphone, adresse de livraison et de facturation.</li>
<li><strong>Données de commande</strong> – produits achetés, prix, historique des commandes, retours et réclamations.</li>
<li><strong>Données de paiement</strong> – moyen de paiement et statut de la transaction. Les données de carte sont traitées par le prestataire de paiement ; nous ne voyons ni ne conservons jamais les numéros de carte complets.</li>
<li><strong>Données de compte</strong> – si vous créez un compte : identifiants de connexion et préférences enregistrées.</li>
<li><strong>Communications</strong> – messages que vous nous envoyez et, si vous vous inscrivez, votre abonnement à la newsletter.</li>
<li><strong>Données techniques</strong> – adresse IP, navigateur, appareil et utilisation du site, collectées au moyen de cookies et de technologies similaires (voir section 7).</li>
</ul>
<h2>3. Finalités et bases juridiques</h2>
<ul>
<li>Traiter et livrer votre commande, votre paiement, vos retours et réclamations – <em>exécution du contrat</em> (art. 6, paragraphe 1, point b) du RGPD).</li>
<li>Fournir votre compte client – <em>exécution du contrat</em>.</li>
<li>Comptabilité et autres obligations légales, par exemple au titre de la loi suédoise sur la comptabilité et du droit de la consommation – <em>obligation légale</em> (art. 6, paragraphe 1, point c)).</li>
<li>Service client, prévention de la fraude et des abus, sécurité du site et constatation, exercice ou défense de droits en justice – <em>intérêts légitimes</em> (art. 6, paragraphe 1, point f)).</li>
<li>Newsletter et marketing par e-mail – votre <em>consentement</em> (art. 6, paragraphe 1, point a)) ou, lorsque la loi le permet, notre intérêt légitime à proposer des produits similaires aux clients existants. Vous pouvez vous y opposer à tout moment.</li>
<li>Cookies d’analyse et de marketing – votre <em>consentement</em>.</li>
</ul>
<h2>4. Durée de conservation</h2>
<ul>
<li>Les pièces comptables, comme les reçus et les factures, sont conservées sept ans après la fin de l’année civile au cours de laquelle l’exercice comptable s’est terminé, conformément à la loi suédoise sur la comptabilité (bokföringslagen, 1999:1078).</li>
<li>Les autres données de commande et de service client sont conservées le temps nécessaire à l’achat, aux retours et aux réclamations – en principe jusqu’à trois ans après la livraison (délai de réclamation), et plus longtemps uniquement si un dossier est en cours.</li>
<li>Les données de compte sont conservées jusqu’à la fermeture de votre compte.</li>
<li>Les données marketing sont conservées jusqu’au retrait de votre consentement ou à votre désinscription.</li>
</ul>
<h2>5. Destinataires des données</h2>
<p>Nous ne vendons jamais vos données personnelles. Nous ne les partageons que lorsque cela est nécessaire :</p>
<ul>
<li><span data-if="seller.is_independent"><strong>Fournisseur de la plateforme (sous-traitant)</strong> – la boutique fonctionne sur la plateforme de commerce en ligne ShopsDoor, fournie par Namez AB, numéro d’immatriculation 559295-1007, Hagavägen 36, 784 40 Borlänge, Suède. Namez AB exploite la plateforme technique de la boutique et traite les données personnelles pour notre compte en tant que sous-traitant (personuppgiftsbiträde) dans le cadre d’un accord de traitement des données, et ne peut pas les utiliser à ses propres fins.</span><span data-if="seller.is_platform"><strong>Plateforme</strong> – la boutique est exploitée sur la plateforme de commerce en ligne ShopsDoor par Namez AB, qui est le vendeur et le responsable du traitement. Les produits sont présentés par le créateur de la boutique. Les données nécessaires à la livraison sont transmises au fournisseur qui expédie votre commande.</span></li>
<li><span data-if="seller.is_independent"><strong>Sous-traitants ultérieurs</strong></span><span data-if="seller.is_platform"><strong>Sous-traitants</strong></span> – Namez AB fait appel à des prestataires pour l’hébergement et le stockage sur des serveurs situés dans l’UE/EEE, l’envoi d’e-mails et des services techniques similaires.</li>
<li><strong>Prestataires de paiement</strong> – selon le moyen de paiement choisi : Stripe, Kustom (page de paiement) et Klarna (paiement sur facture et en plusieurs fois). Ils traitent les données pour exécuter le paiement. Kustom et Klarna agissent en tant que responsables du traitement indépendants pour les données qu’ils collectent lors du paiement et pour la vérification de solvabilité, selon leurs propres politiques de confidentialité ; Stripe également pour la prévention de la fraude et le respect des obligations réglementaires.</li>
<li><strong>Transporteurs</strong> – nom, adresse et coordonnées pour livrer votre colis et vous envoyer des notifications de livraison.</li>
<li><strong>Autorités et conseillers</strong> – lorsque la loi l’exige (par exemple l’administration fiscale suédoise), pour défendre nos droits, ainsi qu’à notre expert-comptable ou commissaire aux comptes.</li>
</ul>
<h2>6. Transferts hors de l’UE/EEE</h2>
<p>Nous nous efforçons de traiter les données au sein de l’UE/EEE. Si un prestataire traite des données hors de l’UE/EEE, par exemple aux États-Unis, le transfert repose sur une décision d’adéquation (telle que le cadre de protection des données UE–États-Unis) ou sur les clauses contractuelles types de la Commission européenne.</p>
<h2>7. Cookies</h2>
<p>Nous utilisons des cookies nécessaires et des technologies similaires pour assurer le fonctionnement de la boutique, par exemple pour mémoriser votre panier, maintenir votre connexion, enregistrer votre choix de langue et de devise et sécuriser le paiement. Ils ne nécessitent pas de consentement. Les cookies d’analyse ou de marketing ne sont utilisés qu’avec votre consentement. Vous pouvez modifier votre choix à tout moment via le lien « Paramètres des cookies » en bas de la page, ou supprimer les cookies dans votre navigateur.</p>
<p><span data-if="tracking.gated">Si vous y consentez, nous utilisons les services d’analyse et de marketing suivants. Les services de statistiques ne sont chargés que si vous autorisez « Statistiques », et les services de marketing que si vous autorisez « Marketing », dans le bandeau cookies ou sous « Paramètres des cookies ». Ils cessent d’être utilisés lorsque vous retirez votre consentement :</span><span data-if="tracking.ungated">Nous utilisons les services d’analyse et de marketing suivants. Google Analytics, Meta Pixel et TikTok Pixel, lorsqu’ils sont mentionnés ci-dessous, sont chargés dès votre visite de la boutique. Microsoft Clarity, lorsqu’il est mentionné ci-dessous, n’est chargé que si vous autorisez « Statistiques » dans le bandeau cookies ou sous « Paramètres des cookies », et cesse d’être utilisé lorsque vous retirez votre consentement :</span></p>
<p><span data-if="tracking.ga4"><strong>Google Analytics</strong> (Google Ireland Ltd ; Google LLC, États-Unis) – statistiques sur l’utilisation de la boutique (pages consultées, appareil, localisation approximative). Cookies : <em>_ga</em> et <em>_ga_*</em>, jusqu’à 2 ans. Voir la <a href="https://policies.google.com/privacy">politique de confidentialité de Google</a>.</span></p>
<p><span data-if="tracking.meta"><strong>Meta Pixel</strong> (Meta Platforms Ireland Ltd ; Meta Platforms, Inc., États-Unis) – pour mesurer et améliorer nos publicités sur Facebook et Instagram. Cookies : <em>_fbp</em> et <em>_fbc</em>, jusqu’à 90 jours. Meta et nous sommes responsables conjoints de la collecte et de la transmission des données ; Meta est responsable de leur traitement ultérieur. Voir la <a href="https://www.facebook.com/privacy/policy/">politique de confidentialité de Meta</a>.</span></p>
<p><span data-if="tracking.tiktok"><strong>TikTok Pixel</strong> (TikTok Technology Ltd, Irlande) – pour mesurer et améliorer nos publicités sur TikTok. Cookie : <em>_ttp</em>, environ 13 mois. Voir la <a href="https://www.tiktok.com/legal/page/eea/privacy-policy/en">politique de confidentialité de TikTok</a>.</span></p>
<p><span data-if="tracking.clarity"><strong>Microsoft Clarity</strong> (Microsoft Ireland Operations Ltd ; Microsoft Corporation, États-Unis) – cartes de chaleur (heatmaps) et enregistrements de sessions qui montrent comment les visiteurs utilisent la boutique (clics, défilement, mouvements de la souris, pages consultées, appareil et navigateur), afin que nous puissions détecter et corriger les problèmes. Les textes saisis dans les formulaires, les textes de personnalisation et le paiement sont masqués dans les enregistrements, et les données de paiement ne sont jamais enregistrées. Cookies : <em>_clck</em> (environ 1 an) et <em>_clsk</em> (environ 1 jour). Microsoft peut aussi déposer ses propres cookies (par exemple <em>MUID</em>), que nous ne pouvons pas supprimer pour vous. Les enregistrements sont conservés jusqu’à 30 jours, et une sélection d’entre eux jusqu’à 9 mois. Microsoft traite également les données pour ses propres finalités, comme décrit dans la <a href="https://privacy.microsoft.com/privacystatement">déclaration de confidentialité de Microsoft</a>.</span></p>
<p><span data-if="tracking.any">Ces prestataires peuvent transférer des données vers les États-Unis. Le transfert repose sur le EU-US Data Privacy Framework ou sur les clauses contractuelles types de la Commission européenne.</span></p>
<p><strong>Médias externes (YouTube, Vimeo, Google Maps)</strong> – les vidéos YouTube ou Vimeo et les cartes Google Maps présentes sur les pages de la boutique ne s’affichent que si vous autorisez « Médias externes » dans le bandeau cookies ou sous « Paramètres des cookies », ou si vous choisissez d’afficher ce contenu précis. Votre navigateur se connecte alors au fournisseur, qui peut déposer ses propres cookies et recevoir des informations sur votre visite, comme votre adresse IP, et les traite selon sa propre politique de confidentialité.</p>
<p>Votre choix en matière de cookies est enregistré dans votre navigateur avec un identifiant de consentement aléatoire, dans l’entrée localStorage <em>consent:{{store.slug}}</em> et le cookie <em>consent_{{store.slug}}</em> (12 mois). Au bout de 12 mois, nous vous le demandons à nouveau. Pour pouvoir démontrer que vous avez donné ou refusé votre consentement, nous enregistrons chaque choix dans un journal des consentements : l’identifiant de consentement, les catégories choisies, la date et l’heure, la langue et une somme de contrôle du texte affiché, ainsi qu’une adresse IP tronquée et une somme de contrôle de l’identification de votre navigateur (user agent), mais jamais votre adresse IP complète. Le journal est conservé 24 mois. Votre identifiant de consentement est affiché sous « Paramètres des cookies ».</p>
<p>Les cookies tiers de Microsoft (<em>MUID</em>, <em>CLID</em>) et de Google/YouTube ne peuvent pas être supprimés par la boutique lorsque vous retirez votre consentement ; vous pouvez les supprimer dans votre navigateur.</p>
<h2>8. Vos droits</h2>
<p>En vertu du règlement général sur la protection des données (RGPD), vous avez le droit :</p>
<ul>
<li>d’être informé(e) des données que nous traitons à votre sujet et d’y accéder,</li>
<li>de faire rectifier des données inexactes,</li>
<li>de faire effacer des données, sauf si nous sommes tenus de les conserver (par exemple au titre de la loi sur la comptabilité),</li>
<li>de demander la limitation du traitement,</li>
<li>de recevoir les données que vous avez fournies dans un format lisible par machine (portabilité),</li>
<li>de vous opposer à un traitement fondé sur l’intérêt légitime et, à tout moment, à la prospection commerciale,</li>
<li>de retirer votre consentement à tout moment, sans que cela n’affecte le traitement effectué auparavant.</li>
</ul>
<p>Contactez-nous à <a href="mailto:{{trader.email}}">{{trader.email}}</a> pour exercer vos droits. Nous répondons dans un délai d’un mois (prolongeable de deux mois au maximum pour les demandes complexes ; nous vous en informerons le cas échéant).</p>
<h2>9. Réclamations</h2>
<p>Si vous estimez que nous traitons vos données personnelles de manière incorrecte, vous pouvez introduire une réclamation auprès de l’autorité suédoise de protection des données (Integritetsskyddsmyndigheten, IMY), Box 8114, 104 20 Stockholm, Suède, <a href="https://www.imy.se">www.imy.se</a>. Vous pouvez également vous adresser à l’autorité de protection des données du pays de l’UE où vous résidez ou travaillez.</p>
<h2>10. Modifications</h2>
<p>Nous pouvons mettre à jour cette politique. La version en vigueur est toujours disponible sur cette page.</p>
`,
  },
  ar: {
    title: 'سياسة الخصوصية',
    html: `
<p>توضح سياسة الخصوصية هذه كيف يعالج {{trader.legal_name}} البيانات الشخصية عند زيارتك {{store.name}} ‏({{store.url}}) أو الشراء منّا.</p>
<h2>1. المتحكّم في البيانات</h2>
<p>{{trader.legal_name}}<span data-if="trader.org_number">، رقم التسجيل {{trader.org_number}}</span><span data-if="trader.address">، {{trader.address}}</span>، هو المتحكّم المسؤول عن معالجة بياناتك الشخصية. للتواصل: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone">، الهاتف {{trader.phone}}</span>.</p>
<h2>2. البيانات التي نعالجها</h2>
<ul>
<li><strong>بيانات الهوية والاتصال</strong> – الاسم والبريد الإلكتروني ورقم الهاتف وعنوان التوصيل وعنوان الفوترة.</li>
<li><strong>بيانات الطلبات</strong> – المنتجات التي اشتريتها والأسعار وسجل الطلبات والمرتجعات والشكاوى.</li>
<li><strong>بيانات الدفع</strong> – وسيلة الدفع وحالة المعاملة. يتولّى مزوّد خدمة الدفع معالجة بيانات البطاقة، ولا نطّلع أبداً على أرقام البطاقات الكاملة ولا نحفظها.</li>
<li><strong>بيانات الحساب</strong> – إذا أنشأت حساباً: بيانات تسجيل الدخول والإعدادات المحفوظة.</li>
<li><strong>المراسلات</strong> – الرسائل التي ترسلها إلينا، واشتراكك في النشرة البريدية إن سجّلت فيها.</li>
<li><strong>البيانات التقنية</strong> – عنوان IP والمتصفح والجهاز وطريقة استخدامك للموقع، وتُجمع عبر ملفات تعريف الارتباط (الكوكيز) والتقنيات المشابهة (انظر البند 7).</li>
</ul>
<h2>3. أغراض المعالجة وأسسها القانونية</h2>
<ul>
<li>معالجة طلبك وتوصيله، والدفع، والمرتجعات والشكاوى – <em>تنفيذ العقد</em> (المادة 6(1)(ب) من اللائحة العامة لحماية البيانات GDPR).</li>
<li>توفير حساب العميل الخاص بك – <em>تنفيذ العقد</em>.</li>
<li>مسك الدفاتر والالتزامات القانونية الأخرى، مثل قانون المحاسبة السويدي وقوانين حماية المستهلك – <em>التزام قانوني</em> (المادة 6(1)(ج)).</li>
<li>خدمة العملاء، ومنع الاحتيال وإساءة الاستخدام، وحماية الموقع، وإثبات الحقوق القانونية أو المطالبة بها أو الدفاع عنها – <em>المصلحة المشروعة</em> (المادة 6(1)(و)).</li>
<li>النشرة البريدية والتسويق عبر البريد الإلكتروني – <em>موافقتك</em> (المادة 6(1)(أ)) أو، حيث يسمح القانون، مصلحتنا المشروعة في عرض منتجات مشابهة على العملاء الحاليين. يمكنك إلغاء الاشتراك في أي وقت.</li>
<li>ملفات تعريف الارتباط الخاصة بالتحليلات والتسويق – <em>موافقتك</em>.</li>
</ul>
<h2>4. مدة الاحتفاظ بالبيانات</h2>
<ul>
<li>تُحفظ المستندات المحاسبية، مثل الإيصالات والفواتير، مدة سبع سنوات بعد نهاية السنة الميلادية التي انتهت فيها السنة المالية، وفقاً لقانون المحاسبة السويدي (bokföringslagen، 1999:1078).</li>
<li>تُحفظ بيانات الطلبات وخدمة العملاء الأخرى طالما كانت لازمة للشراء والمرتجعات والشكاوى – عادةً حتى ثلاث سنوات من التسليم (مدة تقديم الشكوى)، ولا تُحفظ لمدة أطول إلا إذا كانت هناك قضية قائمة.</li>
<li>تُحفظ بيانات الحساب إلى أن تغلق حسابك.</li>
<li>تُحفظ بيانات التسويق إلى أن تسحب موافقتك أو تلغي اشتراكك.</li>
</ul>
<h2>5. الجهات التي نشارك البيانات معها</h2>
<p>لا نبيع بياناتك الشخصية أبداً، ولا نشاركها إلا عند الضرورة:</p>
<ul>
<li><span data-if="seller.is_independent"><strong>مزوّد المنصة (معالج البيانات)</strong> – يعمل المتجر على منصة التجارة الإلكترونية ShopsDoor التي تقدّمها شركة Namez AB، رقم التسجيل 559295-1007، Hagavägen 36, 784 40 Borlänge، السويد. تشغّل Namez AB المنصة التقنية للمتجر وتعالج البيانات الشخصية نيابةً عنّا بصفتها معالجاً للبيانات (personuppgiftsbiträde) بموجب اتفاقية معالجة بيانات، ولا يحق لها استخدام البيانات لأغراضها الخاصة.</span><span data-if="seller.is_platform"><strong>المنصة</strong> – يُدار المتجر على منصة التجارة الإلكترونية ShopsDoor من قِبل شركة Namez AB، وهي البائع والمتحكّم في البيانات. ويعرض صانع المتجر المنتجات. وتُشارَك البيانات اللازمة للتوصيل مع المورّد الذي يشحن طلبك.</span></li>
<li><span data-if="seller.is_independent"><strong>المعالجون الفرعيون</strong></span><span data-if="seller.is_platform"><strong>معالجو البيانات</strong></span> – تستعين Namez AB بمقاولين فرعيين للاستضافة والتخزين على خوادم داخل الاتحاد الأوروبي/المنطقة الاقتصادية الأوروبية، وإرسال البريد الإلكتروني، وخدمات تقنية مماثلة.</li>
<li><strong>مزوّدو خدمات الدفع</strong> – بحسب وسيلة الدفع التي تختارها: Stripe، وKustom (صفحة الدفع)، وKlarna (الدفع بالفاتورة وبالتقسيط). يعالجون البيانات لتنفيذ الدفع. وتُعدّ Kustom وKlarna متحكّمتين مستقلتين في البيانات التي تجمعانها في صفحة الدفع وعند التحقق الائتماني، وفق سياسات الخصوصية الخاصة بهما؛ وكذلك Stripe فيما يتعلق بمنع الاحتيال والامتثال التنظيمي.</li>
<li><strong>شركات الشحن</strong> – الاسم والعنوان وبيانات الاتصال لتوصيل طردك وإرسال إشعارات التوصيل.</li>
<li><strong>الجهات الرسمية والمستشارون</strong> – عندما يفرض القانون ذلك (مثل مصلحة الضرائب السويدية)، أو لحماية حقوقنا القانونية، وكذلك لمحاسبنا أو مدقق حساباتنا.</li>
</ul>
<h2>6. نقل البيانات خارج الاتحاد الأوروبي/المنطقة الاقتصادية الأوروبية</h2>
<p>نحرص على معالجة البيانات داخل الاتحاد الأوروبي/المنطقة الاقتصادية الأوروبية. وإذا عالج أحد المزوّدين البيانات خارجها، كالولايات المتحدة مثلاً، فإن النقل يستند إلى قرار كفاية (مثل إطار خصوصية البيانات بين الاتحاد الأوروبي والولايات المتحدة) أو إلى البنود التعاقدية القياسية الصادرة عن المفوضية الأوروبية.</p>
<h2>7. ملفات تعريف الارتباط (الكوكيز)</h2>
<p>نستخدم ملفات تعريف الارتباط الضرورية والتقنيات المشابهة لكي يعمل المتجر، مثل تذكّر سلة التسوق، وإبقائك مسجّلاً للدخول، وحفظ اختيارك للغة والعملة، وحماية صفحة الدفع. وهذه لا تتطلّب موافقة. أما ملفات تعريف الارتباط الخاصة بالتحليلات أو التسويق فلا تُستخدم إلا بموافقتك. ويمكنك تغيير اختيارك في أي وقت عبر رابط «إعدادات ملفات تعريف الارتباط» أسفل الصفحة، أو بحذفها من متصفحك.</p>
<p><span data-if="tracking.gated">إذا وافقت، نستخدم خدمات التحليلات والتسويق التالية. ولا تُحمَّل خدمات الإحصاءات إلا إذا سمحت بفئة «الإحصاءات»، ولا تُحمَّل خدمات التسويق إلا إذا سمحت بفئة «التسويق»، وذلك في شريط ملفات تعريف الارتباط أو في «إعدادات ملفات تعريف الارتباط». ويتوقف استخدامها عند سحب موافقتك:</span><span data-if="tracking.ungated">نستخدم خدمات التحليلات والتسويق التالية. تُحمَّل Google Analytics وMeta Pixel وTikTok Pixel، إن وردت أدناه، عند زيارتك للمتجر. أما Microsoft Clarity، إن ورد أدناه، فلا يُحمَّل إلا إذا سمحت بفئة «الإحصاءات» في شريط ملفات تعريف الارتباط أو في «إعدادات ملفات تعريف الارتباط»، ويتوقف استخدامه عند سحب موافقتك:</span></p>
<p><span data-if="tracking.ga4"><strong>Google Analytics</strong> (Google Ireland Ltd؛ Google LLC، الولايات المتحدة) – إحصاءات عن كيفية استخدام المتجر (الصفحات التي تمت زيارتها، والجهاز، والموقع التقريبي). ملفات تعريف الارتباط: <em>_ga</em> و<em>_ga_*</em>، لمدة تصل إلى سنتين. انظر <a href="https://policies.google.com/privacy">سياسة الخصوصية لدى Google</a>.</span></p>
<p><span data-if="tracking.meta"><strong>Meta Pixel</strong> (Meta Platforms Ireland Ltd؛ Meta Platforms, Inc.، الولايات المتحدة) – لقياس إعلاناتنا على Facebook وInstagram وتحسينها. ملفات تعريف الارتباط: <em>_fbp</em> و<em>_fbc</em>، لمدة تصل إلى 90 يوماً. نحن وMeta مسؤولان بشكل مشترك عن جمع البيانات ونقلها، وتتحمّل Meta المسؤولية عن معالجتها اللاحقة. انظر <a href="https://www.facebook.com/privacy/policy/">سياسة الخصوصية لدى Meta</a>.</span></p>
<p><span data-if="tracking.tiktok"><strong>TikTok Pixel</strong> (TikTok Technology Ltd، أيرلندا) – لقياس إعلاناتنا على TikTok وتحسينها. ملف تعريف الارتباط: <em>_ttp</em>، لمدة 13 شهراً تقريباً. انظر <a href="https://www.tiktok.com/legal/page/eea/privacy-policy/en">سياسة الخصوصية لدى TikTok</a>.</span></p>
<p><span data-if="tracking.clarity"><strong>Microsoft Clarity</strong> (Microsoft Ireland Operations Ltd؛ Microsoft Corporation، الولايات المتحدة) – خرائط حرارية وتسجيلات للجلسات تُظهر كيف يستخدم الزوار المتجر (النقرات، والتمرير، وحركة الفأرة، والصفحات التي تمت زيارتها، والجهاز والمتصفح)، لكي نكتشف المشكلات ونصلحها. وتُخفى في التسجيلات النصوص التي تكتبها في النماذج ونصوص التخصيص وصفحة الدفع، ولا تُسجَّل بيانات الدفع أبداً. ملفات تعريف الارتباط: <em>_clck</em> (سنة تقريباً) و<em>_clsk</em> (يوم تقريباً). وقد تضع Microsoft أيضاً ملفات تعريف ارتباط خاصة بها (مثل <em>MUID</em>) لا يمكننا حذفها نيابةً عنك. تُحفظ التسجيلات لمدة تصل إلى 30 يوماً، ويُحفظ جزء منها لمدة تصل إلى 9 أشهر. وتعالج Microsoft البيانات أيضاً لأغراضها الخاصة كما هو موضح في <a href="https://privacy.microsoft.com/privacystatement">بيان الخصوصية لدى Microsoft</a>.</span></p>
<p><span data-if="tracking.any">قد ينقل هؤلاء المزوّدون البيانات إلى الولايات المتحدة، ويستند النقل إلى إطار خصوصية البيانات بين الاتحاد الأوروبي والولايات المتحدة (EU-US Data Privacy Framework) أو إلى البنود التعاقدية القياسية للمفوضية الأوروبية.</span></p>
<p><strong>الوسائط الخارجية (YouTube وVimeo وGoogle Maps)</strong> – لا تُعرض مقاطع الفيديو من YouTube أو Vimeo والخرائط من Google Maps في صفحات المتجر إلا بعد أن تسمح بفئة «الوسائط الخارجية» في شريط ملفات تعريف الارتباط أو في «إعدادات ملفات تعريف الارتباط»، أو عندما تختار عرض ذلك المحتوى بعينه. وعندها يتصل متصفحك بالمزوّد، الذي قد يضع ملفات تعريف ارتباط خاصة به ويتلقى معلومات عن زيارتك، مثل عنوان IP الخاص بك، ويعالجها وفق سياسة الخصوصية الخاصة به.</p>
<p>يُحفظ اختيارك بشأن ملفات تعريف الارتباط في متصفحك مع معرّف موافقة عشوائي، في مُدخل localStorage <em>consent:{{store.slug}}</em> وفي ملف تعريف الارتباط <em>consent_{{store.slug}}</em> (لمدة 12 شهراً)، وبعد 12 شهراً نسألك من جديد. ولكي نتمكن من إثبات أنك منحت الموافقة أو رفضتها، نسجّل كل اختيار في سجل الموافقات: معرّف الموافقة، والفئات التي اخترتها، والوقت، واللغة، ومجموعاً تدقيقياً للنص الذي عُرض عليك، إضافةً إلى عنوان IP مختصر ومجموع تدقيقي لمعرّف متصفحك (user agent)، ولا نسجّل عنوان IP الكامل أبداً. ويُحتفظ بالسجل لمدة 24 شهراً. ويظهر معرّف موافقتك في «إعدادات ملفات تعريف الارتباط».</p>
<p>لا يستطيع المتجر حذف ملفات تعريف الارتباط التابعة لجهات خارجية من Microsoft (<em>MUID</em> و<em>CLID</em>) ومن Google/YouTube عند سحب موافقتك، ويمكنك حذفها من متصفحك.</p>
<h2>8. حقوقك</h2>
<p>بموجب اللائحة العامة لحماية البيانات (GDPR) يحق لك:</p>
<ul>
<li>الاطلاع على البيانات التي نعالجها عنك والحصول على نسخة منها،</li>
<li>تصحيح البيانات غير الدقيقة،</li>
<li>حذف البيانات، ما لم نكن ملزمين بالاحتفاظ بها (مثلاً بموجب قانون المحاسبة)،</li>
<li>طلب تقييد المعالجة،</li>
<li>الحصول على البيانات التي قدّمتها بصيغة قابلة للقراءة آلياً (قابلية نقل البيانات)،</li>
<li>الاعتراض على المعالجة القائمة على المصلحة المشروعة، والاعتراض على التسويق المباشر في أي وقت،</li>
<li>سحب موافقتك في أي وقت، دون أن يؤثر ذلك على المعالجة التي تمّت قبل السحب.</li>
</ul>
<p>لممارسة حقوقك تواصل معنا عبر <a href="mailto:{{trader.email}}">{{trader.email}}</a>. نردّ خلال شهر واحد (ويمكن تمديد المدة شهرين إضافيين كحدّ أقصى في الطلبات المعقّدة، وسنُعلمك بذلك عندئذٍ).</p>
<h2>9. الشكاوى</h2>
<p>إذا رأيت أننا نعالج بياناتك الشخصية بشكل غير صحيح، يمكنك تقديم شكوى إلى الهيئة السويدية لحماية الخصوصية (Integritetsskyddsmyndigheten, IMY)، Box 8114, 104 20 Stockholm، السويد، <a href="https://www.imy.se">www.imy.se</a>. كما يمكنك التوجّه إلى هيئة حماية البيانات في بلد الاتحاد الأوروبي الذي تقيم أو تعمل فيه.</p>
<h2>10. التعديلات</h2>
<p>قد نحدّث هذه السياسة من وقت لآخر، وتكون النسخة السارية متاحة دائماً على هذه الصفحة.</p>
`,
  },
  tr: {
    title: 'Gizlilik Politikası',
    html: `
<p>Bu gizlilik politikası, {{store.name}} ({{store.url}}) sitesini ziyaret ettiğinizde veya bizden alışveriş yaptığınızda {{trader.legal_name}} tarafından kişisel verilerin nasıl işlendiğini açıklar.</p>
<h2>1. Veri sorumlusu</h2>
<p>{{trader.legal_name}}<span data-if="trader.org_number">, sicil no. {{trader.org_number}}</span><span data-if="trader.address">, {{trader.address}}</span>, kişisel verilerinizin işlenmesinden sorumlu veri sorumlusudur. İletişim: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone">, telefon {{trader.phone}}</span>.</p>
<h2>2. İşlediğimiz veriler</h2>
<ul>
<li><strong>Kimlik ve iletişim bilgileri</strong> – ad, e-posta adresi, telefon numarası, teslimat ve fatura adresi.</li>
<li><strong>Sipariş bilgileri</strong> – satın aldığınız ürünler, fiyatlar, sipariş geçmişi, iadeler ve şikâyetler.</li>
<li><strong>Ödeme bilgileri</strong> – ödeme yöntemi ve işlem durumu. Kart bilgileri ödeme hizmeti sağlayıcısı tarafından işlenir; tam kart numaralarını hiçbir zaman görmez ve saklamayız.</li>
<li><strong>Hesap bilgileri</strong> – hesap oluşturursanız: giriş bilgileri ve kayıtlı tercihler.</li>
<li><strong>İletişim kayıtları</strong> – bize gönderdiğiniz mesajlar ve kaydolduysanız bülten aboneliğiniz.</li>
<li><strong>Teknik veriler</strong> – çerezler ve benzeri teknolojiler aracılığıyla toplanan IP adresi, tarayıcı, cihaz ve siteyi nasıl kullandığınız (bkz. bölüm 7).</li>
</ul>
<h2>3. Amaçlar ve hukuki dayanaklar</h2>
<ul>
<li>Siparişinizin, ödemenizin, iade ve şikâyetlerinizin işlenmesi ve teslimat – <em>sözleşmenin ifası</em> (GDPR md. 6(1)(b)).</li>
<li>Müşteri hesabınızın sağlanması – <em>sözleşmenin ifası</em>.</li>
<li>Muhasebe ve diğer yasal yükümlülükler, örneğin İsveç Muhasebe Kanunu ve tüketici mevzuatı – <em>hukuki yükümlülük</em> (md. 6(1)(c)).</li>
<li>Müşteri hizmetleri, dolandırıcılık ve kötüye kullanımın önlenmesi, sitenin güvenliği ve hukuki taleplerin tespiti, ileri sürülmesi veya savunulması – <em>meşru menfaat</em> (md. 6(1)(f)).</li>
<li>Bülten ve e-posta ile pazarlama – <em>onayınız</em> (md. 6(1)(a)) veya yasanın izin verdiği durumlarda mevcut müşterilere benzer ürünler sunma konusundaki meşru menfaatimiz. İstediğiniz zaman abonelikten çıkabilirsiniz.</li>
<li>Analiz ve pazarlama çerezleri – <em>onayınız</em>.</li>
</ul>
<h2>4. Saklama süreleri</h2>
<ul>
<li>Makbuz ve fatura gibi muhasebe kayıtları, İsveç Muhasebe Kanunu (bokföringslagen, 1999:1078) uyarınca, mali yılın sona erdiği takvim yılının bitiminden itibaren yedi yıl saklanır.</li>
<li>Diğer sipariş ve müşteri hizmetleri verileri satın alma, iade ve şikâyetler için gerektiği sürece saklanır – genellikle teslimattan itibaren üç yıla kadar (şikâyet süresi) ve yalnızca devam eden bir işlem varsa daha uzun süre.</li>
<li>Hesap verileri, hesabınızı kapatana kadar saklanır.</li>
<li>Pazarlama verileri, onayınızı geri alana veya abonelikten çıkana kadar saklanır.</li>
</ul>
<h2>5. Verileri paylaştığımız taraflar</h2>
<p>Kişisel verilerinizi asla satmayız. Yalnızca gerekli olduğunda paylaşırız:</p>
<ul>
<li><span data-if="seller.is_independent"><strong>Platform sağlayıcısı (veri işleyen)</strong> – mağaza, Namez AB (sicil no. 559295-1007, Hagavägen 36, 784 40 Borlänge, İsveç) tarafından sağlanan e-ticaret platformu ShopsDoor üzerinde çalışır. Namez AB mağazanın teknik platformunu işletir ve kişisel verileri bir veri işleme sözleşmesi kapsamında bizim adımıza veri işleyen (personuppgiftsbiträde) sıfatıyla işler; verileri kendi amaçları için kullanamaz.</span><span data-if="seller.is_platform"><strong>Platform</strong> – mağaza, ShopsDoor e-ticaret platformunda satıcı ve veri sorumlusu olan Namez AB tarafından işletilmektedir. Ürünleri mağazayı oluşturan kişi sunar. Teslimat için gerekli bilgiler, siparişinizi gönderen tedarikçiyle paylaşılır.</span></li>
<li><span data-if="seller.is_independent"><strong>Alt işleyenler</strong></span><span data-if="seller.is_platform"><strong>Veri işleyenler</strong></span> – Namez AB; AB/AEA içindeki sunucularda barındırma ve depolama, e-posta gönderimi ve benzeri teknik hizmetler için alt yükleniciler kullanır.</li>
<li><strong>Ödeme hizmeti sağlayıcıları</strong> – seçtiğiniz ödeme yöntemine bağlı olarak: Stripe, Kustom (ödeme sayfası) ve Klarna (fatura ile ödeme ve taksit). Ödemeyi gerçekleştirmek için verileri işlerler. Kustom ve Klarna, ödeme sayfasında ve kredi değerlendirmesinde topladıkları veriler için kendi gizlilik politikalarına göre bağımsız veri sorumlusudur; Stripe da dolandırıcılığın önlenmesi ve mevzuata uyum açısından bağımsız veri sorumlusudur.</li>
<li><strong>Kargo şirketleri</strong> – paketinizi teslim etmek ve teslimat bildirimleri göndermek için ad, adres ve iletişim bilgileri.</li>
<li><strong>Resmî makamlar ve danışmanlar</strong> – yasanın gerektirdiği durumlarda (örneğin İsveç Vergi İdaresi), hukuki haklarımızı korumak için ve muhasebecimiz veya denetçimizle.</li>
</ul>
<h2>6. AB/AEA dışına aktarım</h2>
<p>Verileri AB/AEA içinde işlemeye özen gösteririz. Bir sağlayıcı verileri AB/AEA dışında, örneğin ABD'de işlerse aktarım bir yeterlilik kararına (AB-ABD Veri Gizliliği Çerçevesi gibi) veya Avrupa Komisyonu'nun standart sözleşme maddelerine dayanır.</p>
<h2>7. Çerezler</h2>
<p>Mağazanın çalışması için zorunlu çerezler ve benzeri teknolojiler kullanırız; örneğin alışveriş sepetinizi hatırlamak, oturumunuzu açık tutmak, dil ve para birimi seçiminizi kaydetmek ve ödeme sayfasını korumak için. Bunlar onay gerektirmez. Analiz veya pazarlama çerezleri yalnızca onay vermişseniz kullanılır. Seçiminizi istediğiniz zaman sayfanın altındaki “Çerez ayarları” bağlantısından değiştirebilir veya çerezleri tarayıcınızdan silebilirsiniz.</p>
<p><span data-if="tracking.gated">Onay vermeniz hâlinde aşağıdaki analiz ve pazarlama hizmetlerini kullanırız. İstatistik hizmetleri yalnızca “İstatistik” kategorisine, pazarlama hizmetleri ise yalnızca “Pazarlama” kategorisine çerez bildiriminde veya “Çerez ayarları” bölümünde izin verirseniz yüklenir. Onayınızı geri çektiğinizde bu hizmetler kullanılmaz:</span><span data-if="tracking.ungated">Aşağıdaki analiz ve pazarlama hizmetlerini kullanırız. Google Analytics, Meta Pixel ve TikTok Pixel, aşağıda belirtilmişse, mağazayı ziyaret ettiğinizde yüklenir. Microsoft Clarity, aşağıda belirtilmişse, yalnızca çerez bildiriminde veya “Çerez ayarları” bölümünde “İstatistik” kategorisine izin verirseniz yüklenir ve onayınızı geri çektiğinizde kullanılmaz:</span></p>
<p><span data-if="tracking.ga4"><strong>Google Analytics</strong> (Google Ireland Ltd; Google LLC, ABD) – mağazanın nasıl kullanıldığına ilişkin istatistikler (görüntülenen sayfalar, cihaz, yaklaşık konum). Çerezler: <em>_ga</em> ve <em>_ga_*</em>, en fazla 2 yıl. Bkz. <a href="https://policies.google.com/privacy">Google gizlilik politikası</a>.</span></p>
<p><span data-if="tracking.meta"><strong>Meta Pixel</strong> (Meta Platforms Ireland Ltd; Meta Platforms, Inc., ABD) – Facebook ve Instagram’daki reklamlarımızı ölçmek ve iyileştirmek için. Çerezler: <em>_fbp</em> ve <em>_fbc</em>, en fazla 90 gün. Verilerin toplanması ve aktarılmasından Meta ile birlikte ortak sorumluyuz; sonraki işlemelerden Meta sorumludur. Bkz. <a href="https://www.facebook.com/privacy/policy/">Meta gizlilik politikası</a>.</span></p>
<p><span data-if="tracking.tiktok"><strong>TikTok Pixel</strong> (TikTok Technology Ltd, İrlanda) – TikTok’taki reklamlarımızı ölçmek ve iyileştirmek için. Çerez: <em>_ttp</em>, yaklaşık 13 ay. Bkz. <a href="https://www.tiktok.com/legal/page/eea/privacy-policy/en">TikTok gizlilik politikası</a>.</span></p>
<p><span data-if="tracking.clarity"><strong>Microsoft Clarity</strong> (Microsoft Ireland Operations Ltd; Microsoft Corporation, ABD) – sorunları bulup giderebilmemiz için ziyaretçilerin mağazayı nasıl kullandığını (tıklamalar, kaydırma, fare hareketleri, ziyaret edilen sayfalar, cihaz ve tarayıcı) gösteren ısı haritaları ve oturum kayıtları. Formlara yazdığınız metinler, kişiselleştirme metinleri ve ödeme sayfası kayıtlarda maskelenir; ödeme bilgileri asla kaydedilmez. Çerezler: <em>_clck</em> (yaklaşık 1 yıl) ve <em>_clsk</em> (yaklaşık 1 gün). Microsoft ayrıca kendi çerezlerini (örneğin <em>MUID</em>) yerleştirebilir; bunları sizin için silemeyiz. Kayıtlar en fazla 30 gün, bir kısmı ise en fazla 9 ay saklanır. Microsoft verileri, <a href="https://privacy.microsoft.com/privacystatement">Microsoft Gizlilik Bildirimi</a>’nde açıklandığı şekilde kendi amaçları için de işler.</span></p>
<p><span data-if="tracking.any">Bu sağlayıcılar verileri ABD’ye aktarabilir. Aktarım, EU-US Data Privacy Framework’e veya Avrupa Komisyonu’nun standart sözleşme maddelerine dayanır.</span></p>
<p><strong>Harici medya (YouTube, Vimeo, Google Maps)</strong> – mağaza sayfalarındaki YouTube veya Vimeo videoları ve Google Maps haritaları, yalnızca çerez bildiriminde veya “Çerez ayarları” bölümünde “Harici medya” kategorisine izin verdiğinizde ya da o içeriği göstermeyi seçtiğinizde görüntülenir. Bu durumda tarayıcınız sağlayıcıya bağlanır; sağlayıcı kendi çerezlerini yerleştirebilir, ziyaretinizle ilgili bilgileri (örneğin IP adresinizi) alabilir ve bunları kendi gizlilik politikasına göre işler.</p>
<p>Çerez tercihiniz, rastgele bir onay kimliğiyle birlikte tarayıcınızda, <em>consent:{{store.slug}}</em> localStorage kaydında ve <em>consent_{{store.slug}}</em> çerezinde (12 ay) saklanır. 12 ay sonra size yeniden sorarız. Onay verdiğinizi veya reddettiğinizi gösterebilmek için her tercihinizi bir onay kaydına işleriz: onay kimliği, seçtiğiniz kategoriler, zaman, dil ve size gösterilen metnin bir sağlama toplamı ile kısaltılmış bir IP adresi ve tarayıcı kimliğinizin (user agent) bir sağlama toplamı; tam IP adresiniz ise asla kaydedilmez. Kayıt 24 ay saklanır. Onay kimliğiniz “Çerez ayarları” bölümünde gösterilir.</p>
<p>Microsoft’a (<em>MUID</em>, <em>CLID</em>) ve Google/YouTube’a ait üçüncü taraf çerezleri, onayınızı geri çektiğinizde mağaza tarafından silinemez; bunları tarayıcınızdan kaldırabilirsiniz.</p>
<h2>8. Haklarınız</h2>
<p>Genel Veri Koruma Tüzüğü (GDPR) kapsamında şu haklara sahipsiniz:</p>
<ul>
<li>hakkınızda işlediğimiz veriler hakkında bilgi alma ve bunlara erişme,</li>
<li>yanlış verilerin düzeltilmesini isteme,</li>
<li>saklama yükümlülüğümüz yoksa (örneğin Muhasebe Kanunu uyarınca) verilerin silinmesini isteme,</li>
<li>işlemenin kısıtlanmasını talep etme,</li>
<li>sağladığınız verileri makine tarafından okunabilir bir formatta alma (veri taşınabilirliği),</li>
<li>meşru menfaate dayanan işlemeye ve her zaman doğrudan pazarlamaya itiraz etme,</li>
<li>onayınızı istediğiniz zaman geri alma; bu, daha önce yapılan işlemeyi etkilemez.</li>
</ul>
<p>Haklarınızı kullanmak için <a href="mailto:{{trader.email}}">{{trader.email}}</a> adresinden bize ulaşın. Bir ay içinde yanıt veririz (karmaşık taleplerde bu süre en fazla iki ay uzatılabilir; bu durumda sizi bilgilendiririz).</p>
<h2>9. Şikâyetler</h2>
<p>Kişisel verilerinizi hatalı işlediğimizi düşünüyorsanız İsveç Gizliliği Koruma Kurumu'na (Integritetsskyddsmyndigheten, IMY), Box 8114, 104 20 Stockholm, İsveç, <a href="https://www.imy.se">www.imy.se</a> şikâyette bulunabilirsiniz. Ayrıca yaşadığınız veya çalıştığınız AB ülkesindeki veri koruma otoritesine de başvurabilirsiniz.</p>
<h2>10. Değişiklikler</h2>
<p>Bu politikayı güncelleyebiliriz. Yürürlükteki sürüm her zaman bu sayfada yer alır.</p>
`,
  },
};

/* ------------------------------------------------------------------ */
/* Terms of sale                                                       */
/* ------------------------------------------------------------------ */

const TERMS: LocalizedTemplates = {
  sv: {
    title: 'Köpvillkor',
    html: `
<p>Dessa köpvillkor gäller när du som konsument köper varor från {{store.name}} ({{store.url}}). Genom att lägga en beställning godkänner du de villkor som gäller vid beställningstillfället.</p>
<h2>1. Säljare</h2>
<p>{{store.name}} drivs av {{trader.legal_name}}<span data-if="trader.org_number">, org.nr {{trader.org_number}}</span><span data-if="trader.vat_number">, momsregistreringsnummer {{trader.vat_number}}</span>.</p>
<p><span data-if="seller.is_platform">Butiken finns på plattformen ShopsDoor. Namez AB är säljare och din avtalspart; butikens skapare presenterar produkterna.</span></p>
<p><span data-if="trader.address">Adress: {{trader.address}}</span></p>
<p>E-post: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> · Telefon: {{trader.phone}}</span></p>
<h2>2. Beställning och avtal</h2>
<p>För att handla måste du vara minst 18 år eller ha vårdnadshavares godkännande. När du har lagt en beställning skickar vi en orderbekräftelse via e-post. Avtalet är ingånget när orderbekräftelsen har skickats. Kontrollera att uppgifterna i bekräftelsen stämmer och kontakta oss snarast om något är fel.</p>
<p>Om en vara inte kan levereras, till exempel för att den har tagit slut i lager, meddelar vi dig så snart som möjligt och återbetalar det du har betalat för varan.</p>
<h2>3. Priser</h2>
<p>Alla priser anges i den valuta som visas i butiken och inkluderar moms. Fraktkostnad och eventuella avgifter för betalsättet visas i kassan innan du bekräftar köpet. Vi reserverar oss för uppenbara fel i pris eller produktinformation, till exempel tydliga skrivfel. Vid ett sådant fel kontaktar vi dig innan varan skickas, och du kan välja att genomföra köpet till rätt pris eller avstå; har du redan betalat återbetalas hela beloppet.</p>
<h2>4. Betalning</h2>
<p>De betalsätt som erbjuds visas i kassan. Betalningar hanteras av externa betaltjänstleverantörer, till exempel Stripe för kortbetalning eller Kustom Checkout, där betalsätt som faktura och delbetalning tillhandahålls av Klarna. För vissa betalsätt gäller även leverantörens egna villkor. Beloppet debiteras enligt villkoren för det betalsätt du väljer.</p>
<h2>5. Leverans</h2>
<p>Leveranssätt, kostnader och beräknade leveranstider anges i kassan och i våra <a href="/legal/shipping">leveransvillkor</a>. Om ingen leveranstid har avtalats levererar vi utan onödigt dröjsmål och senast inom 30 dagar från beställningen. Risken för varan går över på dig när du eller någon som du har utsett har tagit emot den.</p>
<h2>6. Ångerrätt</h2>
<p>Enligt lagen (2005:59) om distansavtal och avtal utanför affärslokaler har du rätt att ångra ditt köp inom 14 dagar från den dag du tog emot varan, utan att ange något skäl. Vissa varor omfattas inte av ångerrätten. Hur du ångrar köpet, vem som betalar returen och hur återbetalningen går till beskrivs under <a href="/legal/refund">Ångerrätt och returer</a>.</p>
<h2>7. Reklamation</h2>
<p>Om en vara är felaktig har du rätt att reklamera enligt konsumentköplagen (2022:260). Du kan reklamera fel som visar sig inom tre år från att du tog emot varan. Du ska meddela oss inom skälig tid efter att du har upptäckt felet; en reklamation inom två månader räknas alltid som i rätt tid. Fel som visar sig inom två år från leveransen antas ha funnits vid leveransen, om inte annat visas eller detta är oförenligt med varans eller felets art.</p>
<p>Vid fel har du i första hand rätt till reparation eller en ny vara. Om det inte är möjligt eller inte sker inom skälig tid kan du ha rätt till prisavdrag eller att häva köpet. Du kan även ha rätt att hålla inne betalningen och till skadestånd. Kontakta oss på <a href="mailto:{{trader.email}}">{{trader.email}}</a> med ordernummer, en beskrivning av felet och gärna bilder. Vid en befogad reklamation står vi för skäliga returkostnader.</p>
<p>En eventuell garanti är ett tillägg och begränsar inte dina rättigheter enligt lag.</p>
<h2>8. Personuppgifter</h2>
<p>Vi behandlar dina personuppgifter enligt vår <a href="/legal/privacy">integritetspolicy</a>.</p>
<h2>9. Force majeure</h2>
<p>Vi ansvarar inte för förseningar eller hinder som beror på omständigheter utanför vår kontroll, till exempel krig, naturkatastrofer, myndighetsbeslut, strejk eller allvarliga störningar hos transportföretag. Dina rättigheter enligt tvingande konsumentlagstiftning påverkas inte.</p>
<h2>10. Tvister</h2>
<p>Kontakta oss först, så försöker vi lösa saken tillsammans. Om vi inte kommer överens kan du vända dig till Allmänna reklamationsnämnden (ARN), Box 174, 101 23 Stockholm, <a href="https://www.arn.se">www.arn.se</a>. Vi medverkar i ARN:s prövning och följer nämndens rekommendationer. Bor du i ett annat EU-land kan du få kostnadsfri hjälp av Konsumenteuropa (ECC) i ditt hemland, se <a href="https://www.konsumenteuropa.se">www.konsumenteuropa.se</a>.</p>
<p>Svensk lag gäller för köpet. Som konsument behåller du alltid det skydd som tvingande regler i ditt hemland ger dig. Tvister som inte kan lösas på annat sätt prövas av allmän domstol.</p>
<h2>11. Ändringar</h2>
<p>Vi kan komma att ändra dessa villkor. För ditt köp gäller de villkor som var publicerade när du lade din beställning.</p>
`,
  },
  en: {
    title: 'Terms of Sale',
    html: `
<p>These terms of sale apply when you, as a consumer, buy goods from {{store.name}} ({{store.url}}). By placing an order you accept the terms in force at the time of your order.</p>
<h2>1. Seller</h2>
<p>{{store.name}} is operated by {{trader.legal_name}}<span data-if="trader.org_number">, company reg. no. {{trader.org_number}}</span><span data-if="trader.vat_number">, VAT number {{trader.vat_number}}</span>.</p>
<p><span data-if="seller.is_platform">The store runs on the ShopsDoor platform. Namez AB is the seller and your contracting party; the store’s creator presents the products.</span></p>
<p><span data-if="trader.address">Address: {{trader.address}}</span></p>
<p>Email: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> · Phone: {{trader.phone}}</span></p>
<h2>2. Orders and contract</h2>
<p>To shop you must be at least 18 years old or have the consent of a guardian. After you place an order we send you an order confirmation by email. The contract is concluded when the order confirmation has been sent. Please check that the details in the confirmation are correct and contact us as soon as possible if anything is wrong.</p>
<p>If an item cannot be delivered, for example because it has sold out, we will inform you as soon as possible and refund what you paid for it.</p>
<h2>3. Prices</h2>
<p>All prices are shown in the currency displayed in the store and include VAT. Shipping costs and any fees for the payment method are shown at checkout before you confirm your purchase. We reserve the right to correct obvious errors in prices or product information, such as clear typing mistakes. If such an error occurs, we contact you before shipping and you may choose to buy at the correct price or cancel; if you have already paid, the full amount is refunded.</p>
<h2>4. Payment</h2>
<p>The available payment methods are shown at checkout. Payments are handled by external payment providers, for example Stripe for card payments, or Kustom Checkout, where payment methods such as invoice and instalments are provided by Klarna. For some payment methods the provider's own terms also apply. The amount is charged according to the terms of the payment method you choose.</p>
<h2>5. Delivery</h2>
<p>Delivery methods, costs and estimated delivery times are stated at checkout and in our <a href="/legal/shipping">shipping policy</a>. If no delivery time has been agreed, we deliver without undue delay and no later than 30 days after your order. The risk for the goods passes to you when you, or someone you have appointed, have received them.</p>
<h2>6. Right of withdrawal</h2>
<p>Under the Swedish Distance and Off-Premises Contracts Act (2005:59) you have the right to withdraw from your purchase within 14 days of the day you received the goods, without giving any reason. Some goods are excluded from the right of withdrawal. How to withdraw, who pays for the return and how refunds work is described under <a href="/legal/refund">Returns and right of withdrawal</a>.</p>
<h2>7. Complaints about faulty goods</h2>
<p>If an item is faulty you have the right to make a complaint under the Swedish Consumer Sales Act (konsumentköplagen, 2022:260). You can complain about faults that appear within three years of receiving the goods. You must notify us within a reasonable time after discovering the fault; a complaint made within two months is always considered to be in time. Faults that appear within two years of delivery are presumed to have existed at delivery, unless shown otherwise or this is incompatible with the nature of the goods or the fault.</p>
<p>If an item is faulty you are first entitled to a repair or a replacement. If that is not possible or does not happen within a reasonable time, you may be entitled to a price reduction or to cancel the purchase. You may also be entitled to withhold payment and to damages. Contact us at <a href="mailto:{{trader.email}}">{{trader.email}}</a> with your order number, a description of the fault and, if possible, photos. For a justified complaint we pay reasonable return costs.</p>
<p>Any warranty is in addition to, and does not limit, your statutory rights.</p>
<h2>8. Personal data</h2>
<p>We process your personal data in accordance with our <a href="/legal/privacy">privacy policy</a>.</p>
<h2>9. Force majeure</h2>
<p>We are not liable for delays or obstacles caused by circumstances beyond our control, such as war, natural disasters, decisions by authorities, strikes or serious disruptions at carriers. Your rights under mandatory consumer law are not affected.</p>
<h2>10. Disputes</h2>
<p>Please contact us first and we will try to resolve the matter together. If we cannot agree, you can turn to the Swedish National Board for Consumer Disputes (Allmänna reklamationsnämnden, ARN), Box 174, 101 23 Stockholm, Sweden, <a href="https://www.arn.se">www.arn.se</a>. We take part in ARN's proceedings and follow the Board's recommendations. If you live in another EU country, you can get free help from the European Consumer Centre in your country of residence (ECC-Net).</p>
<p>Swedish law applies to the purchase. As a consumer you always keep the protection given to you by mandatory rules of your country of residence. Disputes that cannot be resolved otherwise are decided by the general courts.</p>
<h2>11. Changes</h2>
<p>We may change these terms. Your purchase is governed by the terms published when you placed your order.</p>
`,
  },
  de: {
    title: 'Allgemeine Geschäftsbedingungen',
    html: `
<p>Diese Geschäftsbedingungen gelten, wenn Sie als Verbraucher Waren bei {{store.name}} ({{store.url}}) kaufen. Mit Ihrer Bestellung akzeptieren Sie die zum Zeitpunkt der Bestellung gültigen Bedingungen.</p>
<h2>1. Verkäufer</h2>
<p>{{store.name}} wird betrieben von {{trader.legal_name}}<span data-if="trader.org_number">, Org.-Nr. {{trader.org_number}}</span><span data-if="trader.vat_number">, USt-IdNr. {{trader.vat_number}}</span>.</p>
<p><span data-if="seller.is_platform">Der Shop läuft auf der Plattform ShopsDoor. Namez AB ist Verkäufer und Ihr Vertragspartner; die Person, die den Shop erstellt hat, präsentiert die Produkte.</span></p>
<p><span data-if="trader.address">Adresse: {{trader.address}}</span></p>
<p>E-Mail: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> · Telefon: {{trader.phone}}</span></p>
<h2>2. Bestellung und Vertragsschluss</h2>
<p>Um einzukaufen, müssen Sie mindestens 18 Jahre alt sein oder die Zustimmung eines Erziehungsberechtigten haben. Nach Ihrer Bestellung senden wir Ihnen eine Bestellbestätigung per E-Mail. Der Vertrag kommt zustande, sobald die Bestellbestätigung versandt wurde. Bitte prüfen Sie die Angaben in der Bestätigung und kontaktieren Sie uns umgehend, falls etwas nicht stimmt.</p>
<p>Kann ein Artikel nicht geliefert werden, etwa weil er ausverkauft ist, informieren wir Sie so schnell wie möglich und erstatten den dafür gezahlten Betrag.</p>
<h2>3. Preise</h2>
<p>Alle Preise werden in der im Shop angezeigten Währung angegeben und enthalten die Mehrwertsteuer. Versandkosten und etwaige Gebühren für die Zahlungsart werden im Checkout angezeigt, bevor Sie den Kauf bestätigen. Offensichtliche Fehler bei Preisen oder Produktinformationen, etwa eindeutige Tippfehler, bleiben vorbehalten. In einem solchen Fall kontaktieren wir Sie vor dem Versand, und Sie können wählen, ob Sie zum korrekten Preis kaufen oder vom Kauf absehen; bereits gezahlte Beträge werden vollständig erstattet.</p>
<h2>4. Zahlung</h2>
<p>Die verfügbaren Zahlungsarten werden im Checkout angezeigt. Zahlungen werden von externen Zahlungsdienstleistern abgewickelt, zum Beispiel Stripe für Kartenzahlungen oder Kustom Checkout, bei dem Zahlungsarten wie Rechnungs- und Ratenkauf von Klarna angeboten werden. Für einige Zahlungsarten gelten zusätzlich die Bedingungen des Anbieters. Der Betrag wird gemäß den Bedingungen der gewählten Zahlungsart belastet.</p>
<h2>5. Lieferung</h2>
<p>Versandarten, Kosten und voraussichtliche Lieferzeiten sind im Checkout und in unseren <a href="/legal/shipping">Versandbedingungen</a> angegeben. Wurde keine Lieferzeit vereinbart, liefern wir ohne unangemessene Verzögerung und spätestens 30 Tage nach Ihrer Bestellung. Die Gefahr geht auf Sie über, sobald Sie oder eine von Ihnen benannte Person die Ware erhalten haben.</p>
<h2>6. Widerrufsrecht</h2>
<p>Nach dem schwedischen Gesetz über Fernabsatzverträge und außerhalb von Geschäftsräumen geschlossene Verträge (2005:59) können Sie Ihren Kauf innerhalb von 14 Tagen ab dem Tag, an dem Sie die Ware erhalten haben, ohne Angabe von Gründen widerrufen. Bestimmte Waren sind vom Widerrufsrecht ausgenommen. Wie Sie widerrufen, wer die Rücksendekosten trägt und wie die Erstattung erfolgt, ist unter <a href="/legal/refund">Widerrufsrecht und Rücksendungen</a> beschrieben.</p>
<h2>7. Reklamation bei mangelhafter Ware</h2>
<p>Ist eine Ware mangelhaft, können Sie nach dem schwedischen Verbraucherkaufgesetz (konsumentköplagen, 2022:260) reklamieren. Sie können Mängel reklamieren, die innerhalb von drei Jahren nach Erhalt der Ware auftreten. Sie müssen uns innerhalb angemessener Zeit nach Entdeckung des Mangels benachrichtigen; eine Reklamation innerhalb von zwei Monaten gilt stets als rechtzeitig. Bei Mängeln, die sich innerhalb von zwei Jahren nach Lieferung zeigen, wird vermutet, dass sie bereits bei Lieferung vorlagen, sofern nichts anderes nachgewiesen wird oder dies mit der Art der Ware oder des Mangels unvereinbar ist.</p>
<p>Bei einem Mangel haben Sie zunächst Anspruch auf Reparatur oder Ersatzlieferung. Ist dies nicht möglich oder erfolgt es nicht innerhalb angemessener Zeit, können Sie Anspruch auf Preisminderung oder Rücktritt vom Kauf haben. Sie können außerdem berechtigt sein, die Zahlung zurückzuhalten und Schadensersatz zu verlangen. Kontaktieren Sie uns unter <a href="mailto:{{trader.email}}">{{trader.email}}</a> mit Bestellnummer, einer Beschreibung des Mangels und nach Möglichkeit Fotos. Bei einer berechtigten Reklamation tragen wir angemessene Rücksendekosten.</p>
<p>Eine etwaige Garantie gilt zusätzlich und schränkt Ihre gesetzlichen Rechte nicht ein.</p>
<h2>8. Personenbezogene Daten</h2>
<p>Wir verarbeiten Ihre personenbezogenen Daten gemäß unserer <a href="/legal/privacy">Datenschutzerklärung</a>.</p>
<h2>9. Höhere Gewalt</h2>
<p>Wir haften nicht für Verzögerungen oder Hindernisse aufgrund von Umständen außerhalb unserer Kontrolle, etwa Krieg, Naturkatastrophen, behördliche Entscheidungen, Streiks oder schwerwiegende Störungen bei Versanddienstleistern. Ihre Rechte nach zwingendem Verbraucherrecht bleiben unberührt.</p>
<h2>10. Streitigkeiten</h2>
<p>Bitte wenden Sie sich zunächst an uns, damit wir die Angelegenheit gemeinsam lösen können. Kommt keine Einigung zustande, können Sie sich an die schwedische Verbraucherschlichtungsstelle (Allmänna reklamationsnämnden, ARN), Box 174, 101 23 Stockholm, Schweden, <a href="https://www.arn.se">www.arn.se</a>, wenden. Wir nehmen an Verfahren vor der ARN teil und folgen ihren Empfehlungen. Wenn Sie in einem anderen EU-Land wohnen, erhalten Sie kostenlose Hilfe beim Europäischen Verbraucherzentrum in Ihrem Wohnsitzland (ECC-Net).</p>
<p>Für den Kauf gilt schwedisches Recht. Als Verbraucher behalten Sie stets den Schutz, den Ihnen zwingende Vorschriften Ihres Wohnsitzlandes gewähren. Streitigkeiten, die nicht anders gelöst werden können, entscheiden die ordentlichen Gerichte.</p>
<h2>11. Änderungen</h2>
<p>Wir können diese Bedingungen ändern. Für Ihren Kauf gelten die Bedingungen, die zum Zeitpunkt Ihrer Bestellung veröffentlicht waren.</p>
`,
  },
  fr: {
    title: 'Conditions générales de vente',
    html: `
<p>Les présentes conditions générales de vente s’appliquent lorsque vous achetez, en tant que consommateur, des produits sur {{store.name}} ({{store.url}}). En passant commande, vous acceptez les conditions en vigueur au moment de votre commande.</p>
<h2>1. Vendeur</h2>
<p>{{store.name}} est exploité par {{trader.legal_name}}<span data-if="trader.org_number">, numéro d’immatriculation {{trader.org_number}}</span><span data-if="trader.vat_number">, numéro de TVA {{trader.vat_number}}</span>.</p>
<p><span data-if="seller.is_platform">La boutique fonctionne sur la plateforme ShopsDoor. Namez AB est le vendeur et votre cocontractant ; le créateur de la boutique présente les produits.</span></p>
<p><span data-if="trader.address">Adresse : {{trader.address}}</span></p>
<p>E-mail : <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> · Téléphone : {{trader.phone}}</span></p>
<h2>2. Commande et formation du contrat</h2>
<p>Pour effectuer un achat, vous devez avoir au moins 18 ans ou disposer de l’accord d’un représentant légal. Après votre commande, nous vous envoyons une confirmation de commande par e-mail. Le contrat est conclu dès l’envoi de cette confirmation. Vérifiez que les informations de la confirmation sont exactes et contactez-nous rapidement en cas d’erreur.</p>
<p>Si un article ne peut pas être livré, par exemple parce qu’il est épuisé, nous vous en informons dès que possible et vous remboursons le montant payé pour cet article.</p>
<h2>3. Prix</h2>
<p>Tous les prix sont indiqués dans la devise affichée dans la boutique et s’entendent TVA comprise. Les frais de livraison et les éventuels frais liés au moyen de paiement sont affichés lors du paiement, avant la confirmation de votre achat. Nous nous réservons le droit de corriger les erreurs manifestes de prix ou d’information produit, comme une faute de frappe évidente. Dans ce cas, nous vous contactons avant l’expédition et vous pouvez choisir d’acheter au prix correct ou d’annuler ; si vous avez déjà payé, l’intégralité du montant vous est remboursée.</p>
<h2>4. Paiement</h2>
<p>Les moyens de paiement disponibles sont affichés lors du paiement. Les paiements sont traités par des prestataires externes, par exemple Stripe pour les paiements par carte, ou Kustom Checkout, où des moyens de paiement tels que le paiement sur facture et en plusieurs fois sont fournis par Klarna. Pour certains moyens de paiement, les conditions propres du prestataire s’appliquent également. Le montant est débité selon les conditions du moyen de paiement choisi.</p>
<h2>5. Livraison</h2>
<p>Les modes de livraison, les frais et les délais estimés sont indiqués lors du paiement et dans notre <a href="/legal/shipping">politique de livraison</a>. Si aucun délai n’a été convenu, nous livrons sans retard injustifié et au plus tard 30 jours après votre commande. Le risque lié aux produits vous est transféré lorsque vous-même, ou une personne que vous avez désignée, les avez reçus.</p>
<h2>6. Droit de rétractation</h2>
<p>Conformément à la loi suédoise sur les contrats à distance et hors établissement (2005:59), vous disposez d’un délai de 14 jours à compter du jour de réception des produits pour vous rétracter, sans avoir à motiver votre décision. Certains produits sont exclus du droit de rétractation. La procédure de rétractation, la prise en charge des frais de retour et les modalités de remboursement sont décrites dans <a href="/legal/refund">Droit de rétractation et retours</a>.</p>
<h2>7. Réclamations pour produits défectueux</h2>
<p>Si un produit est défectueux, vous pouvez faire une réclamation au titre de la loi suédoise sur la vente aux consommateurs (konsumentköplagen, 2022:260). Vous pouvez signaler les défauts qui apparaissent dans les trois ans suivant la réception du produit. Vous devez nous informer dans un délai raisonnable après la découverte du défaut ; une réclamation faite dans les deux mois est toujours considérée comme faite à temps. Les défauts qui apparaissent dans les deux ans suivant la livraison sont présumés avoir existé lors de la livraison, sauf preuve contraire ou si cela est incompatible avec la nature du produit ou du défaut.</p>
<p>En cas de défaut, vous avez d’abord droit à la réparation ou au remplacement du produit. Si cela n’est pas possible ou n’intervient pas dans un délai raisonnable, vous pouvez avoir droit à une réduction du prix ou à l’annulation de l’achat. Vous pouvez également avoir le droit de suspendre le paiement et d’obtenir des dommages et intérêts. Contactez-nous à <a href="mailto:{{trader.email}}">{{trader.email}}</a> en indiquant votre numéro de commande, une description du défaut et, si possible, des photos. Pour une réclamation justifiée, nous prenons en charge les frais de retour raisonnables.</p>
<p>Une éventuelle garantie commerciale s’ajoute à vos droits légaux et ne les limite pas.</p>
<h2>8. Données personnelles</h2>
<p>Nous traitons vos données personnelles conformément à notre <a href="/legal/privacy">politique de confidentialité</a>.</p>
<h2>9. Force majeure</h2>
<p>Nous ne sommes pas responsables des retards ou empêchements dus à des circonstances indépendantes de notre volonté, telles qu’une guerre, une catastrophe naturelle, une décision des autorités, une grève ou de graves perturbations chez les transporteurs. Vos droits au titre des règles impératives de protection des consommateurs ne sont pas affectés.</p>
<h2>10. Litiges</h2>
<p>Contactez-nous d’abord afin que nous puissions trouver ensemble une solution. À défaut d’accord, vous pouvez saisir la commission nationale suédoise des litiges de consommation (Allmänna reklamationsnämnden, ARN), Box 174, 101 23 Stockholm, Suède, <a href="https://www.arn.se">www.arn.se</a>. Nous participons aux procédures de l’ARN et suivons ses recommandations. Si vous résidez dans un autre pays de l’UE, vous pouvez obtenir une aide gratuite auprès du Centre européen des consommateurs de votre pays de résidence (réseau ECC-Net).</p>
<p>L’achat est régi par le droit suédois. En tant que consommateur, vous conservez toujours la protection que vous accordent les dispositions impératives de votre pays de résidence. Les litiges qui ne peuvent être résolus autrement sont tranchés par les juridictions de droit commun.</p>
<h2>11. Modifications</h2>
<p>Nous pouvons modifier les présentes conditions. Votre achat est régi par les conditions publiées au moment de votre commande.</p>
`,
  },
  ar: {
    title: 'شروط البيع',
    html: `
<p>تسري شروط البيع هذه عندما تشتري، بصفتك مستهلكاً، منتجات من {{store.name}} ‏({{store.url}}). وبتقديمك الطلب فإنك توافق على الشروط السارية وقت الطلب.</p>
<h2>1. البائع</h2>
<p>يدير {{store.name}} البائعُ {{trader.legal_name}}<span data-if="trader.org_number">، رقم التسجيل {{trader.org_number}}</span><span data-if="trader.vat_number">، رقم ضريبة القيمة المضافة {{trader.vat_number}}</span>.</p>
<p><span data-if="seller.is_platform">يعمل المتجر على منصة ShopsDoor. وNamez AB هي البائع والطرف المتعاقد معك، ويعرض صانع المتجر المنتجات.</span></p>
<p><span data-if="trader.address">العنوان: {{trader.address}}</span></p>
<p>البريد الإلكتروني: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> · الهاتف: {{trader.phone}}</span></p>
<h2>2. الطلب وإبرام العقد</h2>
<p>يجب أن يكون عمرك 18 عاماً على الأقل أو أن تحصل على موافقة وليّ أمرك للشراء. بعد تقديم طلبك نرسل إليك تأكيداً للطلب عبر البريد الإلكتروني، ويُبرم العقد عند إرسال هذا التأكيد. يُرجى التحقق من صحة البيانات الواردة في التأكيد والتواصل معنا في أقرب وقت إذا وُجد أي خطأ.</p>
<p>إذا تعذّر توصيل منتج ما، كأن تنفد كميته مثلاً، فسنبلغك بذلك في أقرب وقت ممكن ونعيد إليك ما دفعته مقابله.</p>
<h2>3. الأسعار</h2>
<p>تُعرض جميع الأسعار بالعملة الظاهرة في المتجر وتشمل ضريبة القيمة المضافة. وتظهر تكاليف الشحن وأي رسوم خاصة بوسيلة الدفع في صفحة الدفع قبل تأكيد الشراء. ونحتفظ بحق تصحيح الأخطاء الواضحة في الأسعار أو معلومات المنتجات، كالأخطاء المطبعية الجلية، وفي هذه الحالة نتواصل معك قبل شحن المنتج، ويحق لك أن تختار إتمام الشراء بالسعر الصحيح أو العدول عنه، وإذا كنت قد دفعت فسيُعاد إليك المبلغ كاملاً.</p>
<h2>4. الدفع</h2>
<p>تظهر وسائل الدفع المتاحة في صفحة الدفع. ويتولّى معالجة المدفوعات مزوّدو خدمات دفع خارجيون، مثل Stripe للدفع بالبطاقة، أو Kustom Checkout حيث تقدّم Klarna وسائل دفع مثل الدفع بالفاتورة وبالتقسيط. وتسري على بعض وسائل الدفع شروط المزوّد الخاصة أيضاً. ويُخصم المبلغ وفق شروط وسيلة الدفع التي تختارها.</p>
<h2>5. التوصيل</h2>
<p>تُذكر طرق التوصيل وتكاليفه ومواعيده التقديرية في صفحة الدفع وفي <a href="/legal/shipping">سياسة الشحن</a> الخاصة بنا. وإذا لم يُتّفق على موعد للتوصيل، فإننا نسلّم دون تأخير غير مبرر وفي موعد أقصاه 30 يوماً من تاريخ الطلب. وتنتقل إليك تبعة هلاك المنتج أو تلفه عند استلامك له أنت أو من تعيّنه لذلك.</p>
<h2>6. حق العدول (الانسحاب)</h2>
<p>وفقاً للقانون السويدي بشأن العقود عن بُعد والعقود المبرمة خارج المحال التجارية (2005:59)، يحق لك العدول عن الشراء خلال 14 يوماً من يوم استلامك المنتج، دون الحاجة إلى ذكر سبب. وتُستثنى بعض المنتجات من حق العدول. وتجد طريقة العدول، ومن يتحمّل تكلفة الإرجاع، وكيفية استرداد المبلغ في صفحة <a href="/legal/refund">حق العدول والإرجاع</a>.</p>
<h2>7. الشكوى من عيوب المنتجات</h2>
<p>إذا كان المنتج معيباً يحق لك تقديم شكوى وفقاً لقانون البيع للمستهلك السويدي (konsumentköplagen، 2022:260). ويمكنك الشكوى من العيوب التي تظهر خلال ثلاث سنوات من استلام المنتج. ويجب إبلاغنا خلال مدة معقولة من اكتشاف العيب، وتُعدّ الشكوى المقدَّمة خلال شهرين مقدَّمة في الوقت المناسب دائماً. ويُفترض أن العيوب التي تظهر خلال سنتين من التسليم كانت موجودة عند التسليم، ما لم يثبت خلاف ذلك أو كان ذلك متعارضاً مع طبيعة المنتج أو العيب.</p>
<p>عند وجود عيب يحق لك أولاً إصلاح المنتج أو استبداله. فإن تعذّر ذلك أو لم يتم خلال مدة معقولة، فقد يحق لك تخفيض السعر أو فسخ الشراء. كما قد يحق لك حبس الثمن (الامتناع عن الدفع) والمطالبة بالتعويض. تواصل معنا عبر <a href="mailto:{{trader.email}}">{{trader.email}}</a> مع ذكر رقم الطلب ووصف العيب وإرفاق صور إن أمكن. وفي حال كانت الشكوى مبرَّرة نتحمّل تكاليف الإرجاع المعقولة.</p>
<p>أي ضمان إضافي يُمنح لك يكون إضافةً إلى حقوقك القانونية ولا يقيّدها.</p>
<h2>8. البيانات الشخصية</h2>
<p>نعالج بياناتك الشخصية وفقاً لـ<a href="/legal/privacy">سياسة الخصوصية</a> الخاصة بنا.</p>
<h2>9. القوة القاهرة</h2>
<p>لا نتحمّل المسؤولية عن التأخير أو العوائق الناجمة عن ظروف خارجة عن إرادتنا، مثل الحروب أو الكوارث الطبيعية أو قرارات السلطات أو الإضرابات أو الاضطرابات الجسيمة لدى شركات الشحن. ولا يمسّ ذلك حقوقك بموجب قوانين حماية المستهلك الملزمة.</p>
<h2>10. النزاعات</h2>
<p>يُرجى التواصل معنا أولاً لنحاول حلّ المسألة معاً. وإذا لم نتوصّل إلى اتفاق، يمكنك اللجوء إلى المجلس الوطني السويدي لنزاعات المستهلكين (Allmänna reklamationsnämnden, ARN)، Box 174, 101 23 Stockholm، السويد، <a href="https://www.arn.se">www.arn.se</a>. ونحن نشارك في إجراءات النظر لدى ARN ونلتزم بتوصياته. وإذا كنت تقيم في بلد آخر من بلدان الاتحاد الأوروبي، يمكنك الحصول على مساعدة مجانية من المركز الأوروبي للمستهلك في بلد إقامتك (شبكة ECC-Net).</p>
<p>يسري القانون السويدي على عملية الشراء. وبصفتك مستهلكاً تحتفظ دائماً بالحماية التي تمنحك إياها القواعد الملزمة في بلد إقامتك. وتفصل المحاكم العامة في النزاعات التي يتعذّر حلّها بطريقة أخرى.</p>
<h2>11. التعديلات</h2>
<p>قد نعدّل هذه الشروط، وتسري على مشترياتك الشروط المنشورة وقت تقديم طلبك.</p>
`,
  },
  tr: {
    title: 'Satış Koşulları',
    html: `
<p>Bu satış koşulları, bir tüketici olarak {{store.name}} ({{store.url}}) üzerinden ürün satın aldığınızda geçerlidir. Sipariş vererek sipariş anında yürürlükte olan koşulları kabul etmiş olursunuz.</p>
<h2>1. Satıcı</h2>
<p>{{store.name}}, {{trader.legal_name}} tarafından işletilmektedir<span data-if="trader.org_number">; sicil no. {{trader.org_number}}</span><span data-if="trader.vat_number">, KDV numarası {{trader.vat_number}}</span>.</p>
<p><span data-if="seller.is_platform">Mağaza ShopsDoor platformunda çalışır. Satıcı ve sözleşme tarafınız Namez AB’dir; ürünleri mağazayı oluşturan kişi sunar.</span></p>
<p><span data-if="trader.address">Adres: {{trader.address}}</span></p>
<p>E-posta: <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> · Telefon: {{trader.phone}}</span></p>
<h2>2. Sipariş ve sözleşmenin kurulması</h2>
<p>Alışveriş yapabilmek için en az 18 yaşında olmanız veya velinizin onayına sahip olmanız gerekir. Siparişinizi verdikten sonra size e-posta ile bir sipariş onayı göndeririz. Sözleşme, sipariş onayı gönderildiğinde kurulur. Lütfen onaydaki bilgilerin doğru olduğunu kontrol edin ve bir hata varsa en kısa sürede bizimle iletişime geçin.</p>
<p>Bir ürün, örneğin stokta kalmadığı için teslim edilemezse sizi en kısa sürede bilgilendirir ve o ürün için ödediğiniz tutarı iade ederiz.</p>
<h2>3. Fiyatlar</h2>
<p>Tüm fiyatlar mağazada gösterilen para biriminde belirtilir ve KDV dahildir. Kargo ücreti ve ödeme yöntemine ait olası ücretler, satın alımı onaylamadan önce ödeme sayfasında gösterilir. Fiyat veya ürün bilgilerindeki açık hataları, örneğin bariz yazım hatalarını düzeltme hakkımız saklıdır. Böyle bir durumda ürün gönderilmeden önce sizinle iletişime geçeriz; satın alımı doğru fiyattan tamamlamayı veya vazgeçmeyi seçebilirsiniz; ödeme yaptıysanız tutarın tamamı iade edilir.</p>
<h2>4. Ödeme</h2>
<p>Kullanılabilir ödeme yöntemleri ödeme sayfasında gösterilir. Ödemeler harici ödeme hizmeti sağlayıcıları tarafından işlenir; örneğin kartla ödemeler için Stripe veya fatura ile ödeme ve taksit gibi ödeme yöntemlerinin Klarna tarafından sunulduğu Kustom Checkout. Bazı ödeme yöntemlerinde sağlayıcının kendi koşulları da geçerlidir. Tutar, seçtiğiniz ödeme yönteminin koşullarına göre tahsil edilir.</p>
<h2>5. Teslimat</h2>
<p>Teslimat yöntemleri, ücretleri ve tahmini teslimat süreleri ödeme sayfasında ve <a href="/legal/shipping">kargo ve teslimat koşullarımızda</a> belirtilir. Bir teslimat süresi kararlaştırılmamışsa ürünleri gereksiz gecikme olmaksızın ve en geç siparişten itibaren 30 gün içinde teslim ederiz. Ürünlere ilişkin risk, siz veya belirlediğiniz bir kişi ürünleri teslim aldığında size geçer.</p>
<h2>6. Cayma hakkı</h2>
<p>İsveç Mesafeli Sözleşmeler ve İşyeri Dışında Kurulan Sözleşmeler Kanunu (2005:59) uyarınca, ürünü teslim aldığınız günden itibaren 14 gün içinde herhangi bir gerekçe göstermeden satın alımdan cayma hakkınız vardır. Bazı ürünler cayma hakkı kapsamı dışındadır. Nasıl cayacağınız, iade masraflarını kimin ödeyeceği ve geri ödemenin nasıl yapılacağı <a href="/legal/refund">Cayma Hakkı ve İadeler</a> sayfasında açıklanmıştır.</p>
<h2>7. Ayıplı ürün şikâyetleri</h2>
<p>Bir ürün ayıplıysa İsveç Tüketici Satışları Kanunu (konsumentköplagen, 2022:260) uyarınca şikâyette bulunma hakkınız vardır. Ürünü teslim aldıktan sonraki üç yıl içinde ortaya çıkan ayıplar için şikâyette bulunabilirsiniz. Ayıbı fark ettikten sonra makul bir süre içinde bize bildirmeniz gerekir; iki ay içinde yapılan bir şikâyet her zaman zamanında kabul edilir. Teslimattan sonraki iki yıl içinde ortaya çıkan ayıpların, aksi kanıtlanmadıkça veya bu durum ürünün ya da ayıbın niteliğiyle bağdaşmadıkça, teslimat anında mevcut olduğu varsayılır.</p>
<p>Ayıp durumunda öncelikle onarım veya yeni ürünle değişim hakkınız vardır. Bu mümkün değilse veya makul bir süre içinde gerçekleşmezse fiyat indirimi veya satın alımın iptali hakkınız olabilir. Ayrıca ödemeyi durdurma ve tazminat talep etme hakkınız da olabilir. Sipariş numaranız, ayıbın açıklaması ve mümkünse fotoğraflarla birlikte <a href="mailto:{{trader.email}}">{{trader.email}}</a> adresinden bize ulaşın. Haklı bir şikâyette makul iade masraflarını biz karşılarız.</p>
<p>Olası bir garanti, yasal haklarınıza ek niteliktedir ve bunları sınırlamaz.</p>
<h2>8. Kişisel veriler</h2>
<p>Kişisel verilerinizi <a href="/legal/privacy">gizlilik politikamıza</a> uygun olarak işleriz.</p>
<h2>9. Mücbir sebepler</h2>
<p>Savaş, doğal afetler, resmî makam kararları, grevler veya kargo şirketlerindeki ciddi aksaklıklar gibi kontrolümüz dışındaki durumlardan kaynaklanan gecikme veya engellerden sorumlu değiliz. Emredici tüketici mevzuatından doğan haklarınız etkilenmez.</p>
<h2>10. Uyuşmazlıklar</h2>
<p>Lütfen önce bizimle iletişime geçin; sorunu birlikte çözmeye çalışalım. Anlaşamazsak İsveç Ulusal Tüketici Uyuşmazlıkları Kurulu'na (Allmänna reklamationsnämnden, ARN), Box 174, 101 23 Stockholm, İsveç, <a href="https://www.arn.se">www.arn.se</a> başvurabilirsiniz. ARN'deki inceleme süreçlerine katılır ve Kurul'un tavsiyelerine uyarız. Başka bir AB ülkesinde yaşıyorsanız ikamet ettiğiniz ülkedeki Avrupa Tüketici Merkezi'nden (ECC-Net) ücretsiz yardım alabilirsiniz.</p>
<p>Satın alım İsveç hukukuna tabidir. Tüketici olarak, ikamet ettiğiniz ülkenin emredici kurallarının size sağladığı korumayı her zaman korursunuz. Başka yolla çözülemeyen uyuşmazlıklar genel mahkemelerce karara bağlanır.</p>
<h2>11. Değişiklikler</h2>
<p>Bu koşulları değiştirebiliriz. Satın alımınıza, siparişinizi verdiğiniz sırada yayımlanmış olan koşullar uygulanır.</p>
`,
  },
};

/* ------------------------------------------------------------------ */
/* Returns and right of withdrawal                                     */
/* ------------------------------------------------------------------ */

const REFUND: LocalizedTemplates = {
  sv: {
    title: 'Ångerrätt och returer',
    html: `
<h2>1. Din ångerrätt</h2>
<p>Enligt lagen (2005:59) om distansavtal och avtal utanför affärslokaler har du som konsument rätt att ångra ditt köp från {{store.name}} inom 14 dagar utan att ange något skäl. Ångerfristen börjar den dag du tar emot varan. Om en beställning levereras i flera delar börjar fristen när du har tagit emot den sista varan.</p>
<h2>2. Så ångrar du ditt köp</h2>
<p>Meddela oss innan ångerfristen har gått ut genom ett tydligt meddelande, på något av följande sätt:</p>
<ul>
<li>via e-post till <a href="mailto:{{trader.email}}">{{trader.email}}</a>, eller</li>
<li>genom att fylla i och skicka standardformuläret för ångerrätt längst ner på denna sida.</li>
</ul>
<p>Ange ditt namn, ordernummer och vilka varor det gäller. Det räcker att du skickar meddelandet innan fristen löper ut. Att enbart skicka tillbaka varan räknas inte som att du har ångrat köpet, om du inte samtidigt skickar med ett tydligt meddelande.</p>
<h2>3. Returnera varan</h2>
<p>Skicka tillbaka varan senast 14 dagar efter att du meddelade att du ångrar köpet, till den returadress vi anger när du kontaktar oss<span data-if="seller.is_independent"><span data-if="trader.address">, annars till {{trader.address}}</span></span>. Packa varan väl, gärna i originalförpackningen, och spara kvittot från inlämningen.</p>
<p>Du betalar själv kostnaden för att returnera varan, om inte annat anges i kassan eller i orderbekräftelsen.</p>
<h2>4. Varans skick</h2>
<p>Du får undersöka varan på samma sätt som i en fysisk butik, till exempel prova ett plagg. Om du har hanterat varan mer än vad som behövs för att fastställa dess egenskaper och funktion får vi göra ett avdrag från återbetalningen som motsvarar varans värdeminskning.</p>
<h2>5. Återbetalning</h2>
<p>Vi återbetalar det du har betalat, inklusive den ursprungliga fraktkostnaden för standardleverans, senast 14 dagar från den dag vi fick ditt meddelande om att du ångrar köpet. Om du valde ett dyrare leveranssätt än vårt billigaste standardalternativ återbetalas inte mellanskillnaden. Vi får vänta med återbetalningen tills vi har fått tillbaka varan eller du har visat att du har skickat den, beroende på vad som inträffar först.</p>
<p>Återbetalningen görs med samma betalsätt som du använde vid köpet, om vi inte uttryckligen kommer överens om något annat. Du debiteras inga avgifter för återbetalningen.</p>
<h2>6. Undantag från ångerrätten</h2>
<p>Ångerrätten gäller bland annat inte för:</p>
<ul>
<li>varor som har tillverkats enligt dina anvisningar eller fått en tydlig personlig prägel, till exempel med gravyr eller efter egna mått,</li>
<li>varor som snabbt kan försämras eller har kort hållbarhet, till exempel livsmedel och färska blommor,</li>
<li>förseglade varor som av hälso- eller hygienskäl inte bör returneras och där förseglingen har brutits efter leveransen, till exempel kosmetika och hygienartiklar,</li>
<li>förseglade ljud- eller bildupptagningar och datorprogram där förseglingen har brutits efter leveransen,</li>
<li>varor som efter leveransen har blandats med andra varor så att de inte kan skiljas åt,</li>
<li>tidningar och tidskrifter, utom prenumerationer,</li>
<li>digitalt innehåll som inte levereras på ett fysiskt medium, när leveransen har påbörjats med ditt uttryckliga samtycke och du har godtagit att ångerrätten därmed upphör.</li>
</ul>
<p>När ett undantag gäller en vara informerar vi om det på produktsidan.</p>
<h2>7. Felaktiga, skadade eller fel varor</h2>
<p>Om du har fått en felaktig, skadad eller fel vara gäller inte reglerna om ångerrätt, utan din rätt att reklamera enligt konsumentköplagen. Kontakta oss på <a href="mailto:{{trader.email}}">{{trader.email}}</a> med ordernummer och gärna bilder, så hjälper vi dig. Vid en befogad reklamation betalar du inte för returen. Anmäl transportskador så snart som möjligt och spara gärna förpackningen. Läs mer i våra <a href="/legal/terms">köpvillkor</a>.</p>
<h2>8. Byten</h2>
<p>Vill du ha en annan storlek eller färg kan du ångra köpet enligt ovan och lägga en ny beställning, om inte butiken erbjuder byte direkt.</p>
<h2>9. Standardformulär för utövande av ångerrätt</h2>
<p><em>(Fyll i och returnera detta formulär endast om du vill frånträda avtalet.)</em></p>
<p>Till: {{trader.legal_name}}<span data-if="trader.address">, {{trader.address}}</span>, <a href="mailto:{{trader.email}}">{{trader.email}}</a></p>
<ul>
<li>Jag/vi (*) meddelar härmed att jag/vi (*) vill frånträda mitt/vårt (*) avtal om köp av följande varor (*)/tillhandahållande av följande tjänster (*):</li>
<li>Beställd den (*)/mottagen den (*):</li>
<li>Konsumentens/konsumenternas namn:</li>
<li>Konsumentens/konsumenternas adress:</li>
<li>Konsumentens/konsumenternas namnteckning (endast om formuläret lämnas på papper):</li>
<li>Datum:</li>
</ul>
<p>(*) Stryk det som inte gäller.</p>
`,
  },
  en: {
    title: 'Returns and Right of Withdrawal',
    html: `
<h2>1. Your right of withdrawal</h2>
<p>Under the Swedish Distance and Off-Premises Contracts Act (2005:59), as a consumer you have the right to withdraw from your purchase from {{store.name}} within 14 days without giving any reason. The withdrawal period starts on the day you receive the goods. If an order is delivered in several parts, the period starts when you have received the last item.</p>
<h2>2. How to withdraw</h2>
<p>Notify us with a clear statement before the withdrawal period ends, in one of the following ways:</p>
<ul>
<li>by email to <a href="mailto:{{trader.email}}">{{trader.email}}</a>, or</li>
<li>by completing and sending the standard withdrawal form at the bottom of this page.</li>
</ul>
<p>Please state your name, order number and which items your withdrawal concerns. It is enough to send your notice before the period ends. Simply returning the goods is not a withdrawal unless you include a clear statement.</p>
<h2>3. Returning the goods</h2>
<p>Send the goods back no later than 14 days after you notified us of your withdrawal, to the return address we give you when you contact us<span data-if="seller.is_independent"><span data-if="trader.address">, or otherwise to {{trader.address}}</span></span>. Pack the goods securely, preferably in the original packaging, and keep the proof of postage.</p>
<p>You pay the cost of returning the goods unless stated otherwise at checkout or in the order confirmation.</p>
<h2>4. Condition of the goods</h2>
<p>You may examine the goods as you would in a physical shop, for example try on a garment. If you have handled the goods more than necessary to establish their nature, characteristics and functioning, we may deduct an amount corresponding to the loss in value from the refund.</p>
<h2>5. Refunds</h2>
<p>We refund what you have paid, including the original cost of standard delivery, no later than 14 days from the day we received your notice of withdrawal. If you chose a more expensive delivery method than our cheapest standard option, the difference is not refunded. We may withhold the refund until we have received the goods back or you have shown that you have sent them, whichever comes first.</p>
<p>The refund is made using the same payment method you used for the purchase, unless we expressly agree otherwise. You will not be charged any fees for the refund.</p>
<h2>6. Exceptions to the right of withdrawal</h2>
<p>The right of withdrawal does not apply to, among other things:</p>
<ul>
<li>goods made to your specifications or clearly personalised, for example engraved or made to measure,</li>
<li>goods that can deteriorate quickly or have a short shelf life, such as food and fresh flowers,</li>
<li>sealed goods that are not suitable for return for health or hygiene reasons and that have been unsealed after delivery, such as cosmetics and hygiene products,</li>
<li>sealed audio or video recordings and computer software that have been unsealed after delivery,</li>
<li>goods that, after delivery, have been inseparably mixed with other items,</li>
<li>newspapers and magazines, except subscriptions,</li>
<li>digital content not supplied on a physical medium, once delivery has begun with your express consent and your acknowledgement that you thereby lose the right of withdrawal.</li>
</ul>
<p>Where an exception applies to an item, we state this on the product page.</p>
<h2>7. Faulty, damaged or wrong items</h2>
<p>If you have received a faulty, damaged or wrong item, the withdrawal rules do not apply; instead you have the right to complain under the Swedish Consumer Sales Act. Contact us at <a href="mailto:{{trader.email}}">{{trader.email}}</a> with your order number and, if possible, photos, and we will help you. For a justified complaint you do not pay for the return. Report transport damage as soon as possible and keep the packaging if you can. Read more in our <a href="/legal/terms">terms of sale</a>.</p>
<h2>8. Exchanges</h2>
<p>If you want a different size or colour, you can withdraw from the purchase as described above and place a new order, unless the store offers direct exchanges.</p>
<h2>9. Model withdrawal form</h2>
<p><em>(Complete and return this form only if you wish to withdraw from the contract.)</em></p>
<p>To: {{trader.legal_name}}<span data-if="trader.address">, {{trader.address}}</span>, <a href="mailto:{{trader.email}}">{{trader.email}}</a></p>
<ul>
<li>I/We (*) hereby give notice that I/We (*) withdraw from my/our (*) contract of sale of the following goods (*)/for the provision of the following service (*):</li>
<li>Ordered on (*)/received on (*):</li>
<li>Name of consumer(s):</li>
<li>Address of consumer(s):</li>
<li>Signature of consumer(s) (only if this form is notified on paper):</li>
<li>Date:</li>
</ul>
<p>(*) Delete as appropriate.</p>
`,
  },
  de: {
    title: 'Widerrufsrecht und Rücksendungen',
    html: `
<h2>1. Ihr Widerrufsrecht</h2>
<p>Nach dem schwedischen Gesetz über Fernabsatzverträge und außerhalb von Geschäftsräumen geschlossene Verträge (2005:59) haben Sie als Verbraucher das Recht, Ihren Kauf bei {{store.name}} binnen 14 Tagen ohne Angabe von Gründen zu widerrufen. Die Widerrufsfrist beginnt an dem Tag, an dem Sie die Ware erhalten. Wird eine Bestellung in mehreren Teilen geliefert, beginnt die Frist mit Erhalt der letzten Ware.</p>
<h2>2. So widerrufen Sie</h2>
<p>Teilen Sie uns vor Ablauf der Widerrufsfrist Ihren Entschluss mit einer eindeutigen Erklärung mit, auf einem der folgenden Wege:</p>
<ul>
<li>per E-Mail an <a href="mailto:{{trader.email}}">{{trader.email}}</a> oder</li>
<li>indem Sie das Muster-Widerrufsformular am Ende dieser Seite ausfüllen und an uns senden.</li>
</ul>
<p>Bitte geben Sie Ihren Namen, Ihre Bestellnummer und die betroffenen Artikel an. Zur Wahrung der Frist genügt es, die Mitteilung vor Fristablauf abzusenden. Die bloße Rücksendung der Ware gilt nicht als Widerruf, es sei denn, Sie legen eine eindeutige Erklärung bei.</p>
<h2>3. Rücksendung der Ware</h2>
<p>Senden Sie die Ware spätestens 14 Tage nach Ihrer Widerrufsmitteilung an die Rücksendeadresse, die wir Ihnen bei Ihrer Kontaktaufnahme nennen<span data-if="seller.is_independent"><span data-if="trader.address">, andernfalls an {{trader.address}}</span></span>. Verpacken Sie die Ware sorgfältig, möglichst in der Originalverpackung, und bewahren Sie den Einlieferungsbeleg auf.</p>
<p>Sie tragen die unmittelbaren Kosten der Rücksendung, sofern im Checkout oder in der Bestellbestätigung nichts anderes angegeben ist.</p>
<h2>4. Zustand der Ware</h2>
<p>Sie dürfen die Ware so prüfen, wie Sie es in einem Ladengeschäft tun würden, etwa ein Kleidungsstück anprobieren. Haben Sie die Ware über das zur Prüfung ihrer Beschaffenheit, Eigenschaften und Funktionsweise notwendige Maß hinaus genutzt, können wir einen dem Wertverlust entsprechenden Betrag von der Erstattung abziehen.</p>
<h2>5. Erstattung</h2>
<p>Wir erstatten Ihnen alle Zahlungen einschließlich der ursprünglichen Kosten für die Standardlieferung spätestens 14 Tage ab dem Tag, an dem Ihre Widerrufsmitteilung bei uns eingegangen ist. Haben Sie eine teurere Versandart als unsere günstigste Standardlieferung gewählt, wird die Differenz nicht erstattet. Wir können die Erstattung verweigern, bis wir die Ware zurückerhalten haben oder bis Sie nachgewiesen haben, dass Sie die Ware zurückgesandt haben, je nachdem, welches der frühere Zeitpunkt ist.</p>
<p>Für die Erstattung verwenden wir dasselbe Zahlungsmittel, das Sie beim Kauf eingesetzt haben, sofern nicht ausdrücklich etwas anderes vereinbart wurde. Für die Erstattung werden Ihnen keine Gebühren berechnet.</p>
<h2>6. Ausnahmen vom Widerrufsrecht</h2>
<p>Das Widerrufsrecht gilt unter anderem nicht für:</p>
<ul>
<li>Waren, die nach Ihren Vorgaben angefertigt oder eindeutig auf Ihre persönlichen Bedürfnisse zugeschnitten sind, etwa mit Gravur oder nach Maß,</li>
<li>Waren, die schnell verderben können oder eine kurze Haltbarkeit haben, etwa Lebensmittel und frische Blumen,</li>
<li>versiegelte Waren, die aus Gründen des Gesundheitsschutzes oder der Hygiene nicht zur Rückgabe geeignet sind, wenn ihre Versiegelung nach der Lieferung entfernt wurde, etwa Kosmetik und Hygieneartikel,</li>
<li>versiegelte Ton- oder Videoaufnahmen und Computersoftware, wenn die Versiegelung nach der Lieferung entfernt wurde,</li>
<li>Waren, die nach der Lieferung untrennbar mit anderen Gütern vermischt wurden,</li>
<li>Zeitungen und Zeitschriften, ausgenommen Abonnements,</li>
<li>digitale Inhalte, die nicht auf einem körperlichen Datenträger geliefert werden, sobald die Lieferung mit Ihrer ausdrücklichen Zustimmung und Ihrer Bestätigung, dass Sie dadurch Ihr Widerrufsrecht verlieren, begonnen hat.</li>
</ul>
<p>Gilt für einen Artikel eine Ausnahme, weisen wir auf der Produktseite darauf hin.</p>
<h2>7. Mangelhafte, beschädigte oder falsche Artikel</h2>
<p>Haben Sie einen mangelhaften, beschädigten oder falschen Artikel erhalten, gelten nicht die Widerrufsregeln, sondern Ihr Reklamationsrecht nach dem schwedischen Verbraucherkaufgesetz. Kontaktieren Sie uns unter <a href="mailto:{{trader.email}}">{{trader.email}}</a> mit Bestellnummer und nach Möglichkeit Fotos, und wir helfen Ihnen weiter. Bei einer berechtigten Reklamation zahlen Sie die Rücksendung nicht. Melden Sie Transportschäden so schnell wie möglich und bewahren Sie nach Möglichkeit die Verpackung auf. Mehr dazu in unseren <a href="/legal/terms">Geschäftsbedingungen</a>.</p>
<h2>8. Umtausch</h2>
<p>Möchten Sie eine andere Größe oder Farbe, können Sie den Kauf wie oben beschrieben widerrufen und eine neue Bestellung aufgeben, sofern der Shop keinen direkten Umtausch anbietet.</p>
<h2>9. Muster-Widerrufsformular</h2>
<p><em>(Wenn Sie den Vertrag widerrufen wollen, füllen Sie bitte dieses Formular aus und senden Sie es zurück.)</em></p>
<p>An: {{trader.legal_name}}<span data-if="trader.address">, {{trader.address}}</span>, <a href="mailto:{{trader.email}}">{{trader.email}}</a></p>
<ul>
<li>Hiermit widerrufe(n) ich/wir (*) den von mir/uns (*) abgeschlossenen Vertrag über den Kauf der folgenden Waren (*)/die Erbringung der folgenden Dienstleistung (*):</li>
<li>Bestellt am (*)/erhalten am (*):</li>
<li>Name des/der Verbraucher(s):</li>
<li>Anschrift des/der Verbraucher(s):</li>
<li>Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier):</li>
<li>Datum:</li>
</ul>
<p>(*) Unzutreffendes streichen.</p>
`,
  },
  fr: {
    title: 'Droit de rétractation et retours',
    html: `
<h2>1. Votre droit de rétractation</h2>
<p>Conformément à la loi suédoise sur les contrats à distance et hors établissement (2005:59), vous disposez, en tant que consommateur, d’un délai de 14 jours pour vous rétracter de votre achat sur {{store.name}}, sans avoir à motiver votre décision. Le délai court à compter du jour où vous recevez les produits. Si une commande est livrée en plusieurs fois, le délai court à compter de la réception du dernier article.</p>
<h2>2. Comment vous rétracter</h2>
<p>Informez-nous de votre décision par une déclaration dénuée d’ambiguïté avant l’expiration du délai, de l’une des manières suivantes :</p>
<ul>
<li>par e-mail à <a href="mailto:{{trader.email}}">{{trader.email}}</a>, ou</li>
<li>en complétant et en nous envoyant le modèle de formulaire de rétractation figurant au bas de cette page.</li>
</ul>
<p>Indiquez votre nom, votre numéro de commande et les articles concernés. Il suffit d’envoyer votre déclaration avant l’expiration du délai. Le simple renvoi des produits ne vaut pas rétractation, sauf si vous y joignez une déclaration claire.</p>
<h2>3. Retour des produits</h2>
<p>Renvoyez les produits au plus tard 14 jours après nous avoir informés de votre rétractation, à l’adresse de retour que nous vous indiquons lorsque vous nous contactez<span data-if="seller.is_independent"><span data-if="trader.address"> ou, à défaut, à {{trader.address}}</span></span>. Emballez soigneusement les produits, de préférence dans leur emballage d’origine, et conservez la preuve d’envoi.</p>
<p>Les frais directs de renvoi sont à votre charge, sauf indication contraire lors du paiement ou dans la confirmation de commande.</p>
<h2>4. État des produits</h2>
<p>Vous pouvez examiner les produits comme vous le feriez en magasin, par exemple essayer un vêtement. Si vous avez manipulé les produits au-delà de ce qui est nécessaire pour établir leur nature, leurs caractéristiques et leur bon fonctionnement, nous pouvons déduire du remboursement un montant correspondant à la dépréciation.</p>
<h2>5. Remboursement</h2>
<p>Nous vous remboursons tous les paiements reçus, y compris les frais de livraison standard initiaux, au plus tard 14 jours à compter du jour où nous avons reçu votre déclaration de rétractation. Si vous avez choisi un mode de livraison plus coûteux que notre option standard la moins chère, la différence n’est pas remboursée. Nous pouvons différer le remboursement jusqu’à réception des produits ou jusqu’à ce que vous ayez fourni une preuve de leur expédition, la date retenue étant celle du premier de ces faits.</p>
<p>Le remboursement est effectué avec le même moyen de paiement que celui utilisé pour l’achat, sauf accord exprès contraire. Aucuns frais ne vous sont facturés pour ce remboursement.</p>
<h2>6. Exceptions au droit de rétractation</h2>
<p>Le droit de rétractation ne s’applique notamment pas :</p>
<ul>
<li>aux produits confectionnés selon vos spécifications ou nettement personnalisés, par exemple gravés ou réalisés sur mesure,</li>
<li>aux produits susceptibles de se détériorer rapidement ou dont la durée de conservation est courte, comme les denrées alimentaires et les fleurs fraîches,</li>
<li>aux produits scellés qui ne peuvent être renvoyés pour des raisons de protection de la santé ou d’hygiène et qui ont été descellés après la livraison, comme les cosmétiques et les produits d’hygiène,</li>
<li>aux enregistrements audio ou vidéo et aux logiciels scellés qui ont été descellés après la livraison,</li>
<li>aux produits qui, après livraison, ont été mélangés de manière indissociable avec d’autres articles,</li>
<li>aux journaux et magazines, sauf les abonnements,</li>
<li>aux contenus numériques non fournis sur un support matériel, dès lors que la livraison a commencé avec votre accord exprès et votre reconnaissance de la perte de votre droit de rétractation.</li>
</ul>
<p>Lorsqu’une exception s’applique à un article, nous l’indiquons sur la page du produit.</p>
<h2>7. Produits défectueux, endommagés ou erronés</h2>
<p>Si vous avez reçu un produit défectueux, endommagé ou erroné, ce ne sont pas les règles de rétractation qui s’appliquent, mais votre droit de réclamation au titre de la loi suédoise sur la vente aux consommateurs. Contactez-nous à <a href="mailto:{{trader.email}}">{{trader.email}}</a> en indiquant votre numéro de commande et, si possible, en joignant des photos ; nous vous aiderons. En cas de réclamation justifiée, le retour est à notre charge. Signalez les dommages de transport le plus rapidement possible et conservez si possible l’emballage. Pour en savoir plus, consultez nos <a href="/legal/terms">conditions générales de vente</a>.</p>
<h2>8. Échanges</h2>
<p>Si vous souhaitez une autre taille ou une autre couleur, vous pouvez vous rétracter comme indiqué ci-dessus et passer une nouvelle commande, sauf si la boutique propose l’échange direct.</p>
<h2>9. Modèle de formulaire de rétractation</h2>
<p><em>(Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter du contrat.)</em></p>
<p>À l’attention de : {{trader.legal_name}}<span data-if="trader.address">, {{trader.address}}</span>, <a href="mailto:{{trader.email}}">{{trader.email}}</a></p>
<ul>
<li>Je/Nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la vente du bien (*)/pour la prestation de services (*) ci-dessous :</li>
<li>Commandé le (*)/reçu le (*) :</li>
<li>Nom du (des) consommateur(s) :</li>
<li>Adresse du (des) consommateur(s) :</li>
<li>Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) :</li>
<li>Date :</li>
</ul>
<p>(*) Rayez la mention inutile.</p>
`,
  },
  ar: {
    title: 'حق العدول والإرجاع',
    html: `
<h2>1. حقك في العدول</h2>
<p>وفقاً للقانون السويدي بشأن العقود عن بُعد والعقود المبرمة خارج المحال التجارية (2005:59)، يحق لك بصفتك مستهلكاً العدول عن شرائك من {{store.name}} خلال 14 يوماً دون ذكر أي سبب. وتبدأ مدة العدول من يوم استلامك المنتج، وإذا سُلّم الطلب على عدة دفعات فتبدأ المدة من استلامك آخر منتج.</p>
<h2>2. كيف تمارس حق العدول</h2>
<p>أبلغنا قبل انتهاء مدة العدول ببيان واضح، بإحدى الطرق التالية:</p>
<ul>
<li>عبر البريد الإلكتروني إلى <a href="mailto:{{trader.email}}">{{trader.email}}</a>، أو</li>
<li>بتعبئة نموذج العدول القياسي الموجود أسفل هذه الصفحة وإرساله إلينا.</li>
</ul>
<p>يُرجى ذكر اسمك ورقم الطلب والمنتجات المعنية. ويكفي أن ترسل إشعارك قبل انتهاء المدة. ولا يُعدّ إرجاع المنتج وحده عدولاً، ما لم ترفق به بياناً واضحاً.</p>
<h2>3. إرجاع المنتج</h2>
<p>أعد المنتج في موعد أقصاه 14 يوماً من إبلاغنا بالعدول، إلى عنوان الإرجاع الذي نزوّدك به عند تواصلك معنا<span data-if="seller.is_independent"><span data-if="trader.address">، وإلا فإلى {{trader.address}}</span></span>. غلّف المنتج جيداً، ويُفضّل في عبوته الأصلية، واحتفظ بإيصال الشحن.</p>
<p>تتحمّل أنت تكلفة إرجاع المنتج، ما لم يُذكر خلاف ذلك في صفحة الدفع أو في تأكيد الطلب.</p>
<h2>4. حالة المنتج</h2>
<p>يحق لك فحص المنتج كما تفعل في متجر فعلي، كتجربة قطعة ملابس مثلاً. أما إذا استخدمت المنتج بما يتجاوز القدر اللازم لمعرفة طبيعته وخصائصه وطريقة عمله، فيجوز لنا أن نخصم من المبلغ المسترد ما يعادل النقص في قيمته.</p>
<h2>5. استرداد المبلغ</h2>
<p>نعيد إليك ما دفعته، بما في ذلك تكلفة التوصيل القياسي الأصلية، في موعد أقصاه 14 يوماً من يوم تلقّينا إشعار العدول. وإذا اخترت طريقة توصيل أغلى من خيار التوصيل القياسي الأرخص لدينا، فلا يُسترد فرق السعر. ويجوز لنا تأجيل الاسترداد إلى أن نستلم المنتج أو تثبت لنا أنك أرسلته، أيّهما أسبق.</p>
<p>يتم الاسترداد بوسيلة الدفع نفسها التي استخدمتها عند الشراء، ما لم نتفق صراحةً على غير ذلك، ولا تُفرض عليك أي رسوم مقابل الاسترداد.</p>
<h2>6. الاستثناءات من حق العدول</h2>
<p>لا يسري حق العدول، من بين أمور أخرى، على:</p>
<ul>
<li>المنتجات المصنوعة وفق مواصفاتك أو المخصّصة لك بشكل واضح، كالمنتجات المحفورة أو المفصّلة حسب المقاس،</li>
<li>المنتجات القابلة للتلف السريع أو ذات مدة الصلاحية القصيرة، كالأغذية والزهور الطازجة،</li>
<li>المنتجات المختومة غير الصالحة للإرجاع لأسباب صحية أو تتعلق بالنظافة إذا فُتح ختمها بعد التسليم، كمستحضرات التجميل ومنتجات العناية الشخصية،</li>
<li>التسجيلات الصوتية أو المرئية وبرامج الحاسوب المختومة إذا فُتح ختمها بعد التسليم،</li>
<li>المنتجات التي اختلطت بعد التسليم بمنتجات أخرى بحيث يتعذّر فصلها،</li>
<li>الصحف والمجلات، باستثناء الاشتراكات،</li>
<li>المحتوى الرقمي غير المقدَّم على وسيط مادي، متى بدأ تقديمه بموافقتك الصريحة وإقرارك بأنك تفقد بذلك حق العدول.</li>
</ul>
<p>عندما ينطبق استثناء على منتج ما، نوضّح ذلك في صفحة المنتج.</p>
<h2>7. المنتجات المعيبة أو التالفة أو الخاطئة</h2>
<p>إذا استلمت منتجاً معيباً أو تالفاً أو غير الذي طلبته، فلا تسري قواعد العدول، بل حقك في تقديم شكوى بموجب قانون البيع للمستهلك السويدي. تواصل معنا عبر <a href="mailto:{{trader.email}}">{{trader.email}}</a> مع ذكر رقم الطلب وإرفاق صور إن أمكن، وسنساعدك. وفي حال كانت الشكوى مبرَّرة لا تتحمّل تكلفة الإرجاع. أبلغ عن أضرار الشحن في أقرب وقت ممكن واحتفظ بالعبوة إن أمكن. لمزيد من التفاصيل راجع <a href="/legal/terms">شروط البيع</a>.</p>
<h2>8. الاستبدال</h2>
<p>إذا رغبت في مقاس أو لون مختلف، يمكنك العدول عن الشراء كما هو موضّح أعلاه وتقديم طلب جديد، ما لم يتح المتجر الاستبدال المباشر.</p>
<h2>9. نموذج العدول القياسي</h2>
<p><em>(املأ هذا النموذج وأرسله فقط إذا كنت ترغب في العدول عن العقد.)</em></p>
<p>إلى: {{trader.legal_name}}<span data-if="trader.address">، {{trader.address}}</span>، <a href="mailto:{{trader.email}}">{{trader.email}}</a></p>
<ul>
<li>أُبلغكم/نُبلغكم (*) بموجب هذا أنني/أننا (*) أعدل/نعدل (*) عن عقدي/عقدنا (*) لشراء المنتجات التالية (*)/لتقديم الخدمة التالية (*):</li>
<li>تاريخ الطلب (*)/تاريخ الاستلام (*):</li>
<li>اسم المستهلك/المستهلكين:</li>
<li>عنوان المستهلك/المستهلكين:</li>
<li>توقيع المستهلك/المستهلكين (فقط إذا قُدّم هذا النموذج ورقياً):</li>
<li>التاريخ:</li>
</ul>
<p>(*) احذف ما لا ينطبق.</p>
`,
  },
  tr: {
    title: 'Cayma Hakkı ve İadeler',
    html: `
<h2>1. Cayma hakkınız</h2>
<p>İsveç Mesafeli Sözleşmeler ve İşyeri Dışında Kurulan Sözleşmeler Kanunu (2005:59) uyarınca, tüketici olarak {{store.name}} üzerinden yaptığınız satın alımdan 14 gün içinde herhangi bir gerekçe göstermeden cayma hakkınız vardır. Cayma süresi ürünü teslim aldığınız gün başlar. Sipariş birden fazla parça hâlinde teslim edilirse süre, son ürünü teslim aldığınızda başlar.</p>
<h2>2. Nasıl cayabilirsiniz</h2>
<p>Cayma süresi dolmadan önce açık bir beyanla, aşağıdaki yollardan biriyle bize bildirin:</p>
<ul>
<li><a href="mailto:{{trader.email}}">{{trader.email}}</a> adresine e-posta göndererek veya</li>
<li>bu sayfanın altındaki standart cayma formunu doldurup bize göndererek.</li>
</ul>
<p>Lütfen adınızı, sipariş numaranızı ve ilgili ürünleri belirtin. Bildiriminizi süre dolmadan göndermeniz yeterlidir. Ürünü yalnızca geri göndermek, yanına açık bir beyan eklemediğiniz sürece cayma olarak kabul edilmez.</p>
<h2>3. Ürünün iadesi</h2>
<p>Ürünü, caymanızı bildirdikten sonra en geç 14 gün içinde, bizimle iletişime geçtiğinizde bildireceğimiz iade adresine<span data-if="seller.is_independent"><span data-if="trader.address">, aksi hâlde {{trader.address}} adresine</span></span> gönderin. Ürünü, mümkünse orijinal ambalajında, sağlam şekilde paketleyin ve gönderi makbuzunu saklayın.</p>
<p>Ödeme sayfasında veya sipariş onayında aksi belirtilmedikçe iade gönderim masrafını siz ödersiniz.</p>
<h2>4. Ürünün durumu</h2>
<p>Ürünü fiziksel bir mağazada yapacağınız gibi inceleyebilirsiniz; örneğin bir giysiyi deneyebilirsiniz. Ürünü niteliğini, özelliklerini ve işleyişini anlamak için gerekenden fazla kullandıysanız, değer kaybına karşılık gelen tutarı geri ödemeden düşebiliriz.</p>
<h2>5. Geri ödeme</h2>
<p>Cayma bildiriminizi aldığımız günden itibaren en geç 14 gün içinde, ilk standart teslimat ücreti dahil ödediğiniz tutarı iade ederiz. En ucuz standart seçeneğimizden daha pahalı bir teslimat yöntemi seçtiyseniz aradaki fark iade edilmez. Geri ödemeyi, ürünü geri alana veya ürünü gönderdiğinizi kanıtlayana kadar (hangisi önce gerçekleşirse) bekletebiliriz.</p>
<p>Geri ödeme, açıkça farklı bir şekilde anlaşmadıkça satın alımda kullandığınız ödeme yöntemiyle yapılır. Geri ödeme için sizden herhangi bir ücret alınmaz.</p>
<h2>6. Cayma hakkının istisnaları</h2>
<p>Cayma hakkı diğerlerinin yanı sıra şunlar için geçerli değildir:</p>
<ul>
<li>sizin talimatlarınıza göre üretilen veya açıkça kişiselleştirilen ürünler, örneğin gravürlü veya ölçüye göre yapılmış ürünler,</li>
<li>çabuk bozulabilen veya raf ömrü kısa olan ürünler, örneğin gıdalar ve taze çiçekler,</li>
<li>sağlık veya hijyen nedeniyle iadeye uygun olmayan ve teslimattan sonra ambalajı açılmış mühürlü ürünler, örneğin kozmetik ve hijyen ürünleri,</li>
<li>teslimattan sonra ambalajı açılmış mühürlü ses veya görüntü kayıtları ve bilgisayar yazılımları,</li>
<li>teslimattan sonra diğer ürünlerle ayrılamayacak şekilde karışmış ürünler,</li>
<li>abonelikler hariç gazete ve dergiler,</li>
<li>fiziksel bir ortamda sunulmayan dijital içerik; teslimat, açık onayınız ve böylece cayma hakkınızı kaybettiğinizi kabul etmenizle başlamışsa.</li>
</ul>
<p>Bir ürün için istisna geçerliyse bunu ürün sayfasında belirtiriz.</p>
<h2>7. Ayıplı, hasarlı veya yanlış ürünler</h2>
<p>Ayıplı, hasarlı veya yanlış bir ürün aldıysanız cayma kuralları değil, İsveç Tüketici Satışları Kanunu kapsamındaki şikâyet hakkınız geçerlidir. Sipariş numaranız ve mümkünse fotoğraflarla birlikte <a href="mailto:{{trader.email}}">{{trader.email}}</a> adresinden bize ulaşın; size yardımcı olalım. Haklı bir şikâyette iade masrafını siz ödemezsiniz. Taşıma hasarlarını mümkün olan en kısa sürede bildirin ve mümkünse ambalajı saklayın. Ayrıntılar için <a href="/legal/terms">satış koşullarımıza</a> bakın.</p>
<h2>8. Değişim</h2>
<p>Farklı bir beden veya renk istiyorsanız, mağaza doğrudan değişim sunmuyorsa yukarıda açıklandığı şekilde cayabilir ve yeni bir sipariş verebilirsiniz.</p>
<h2>9. Standart cayma formu</h2>
<p><em>(Bu formu yalnızca sözleşmeden caymak istiyorsanız doldurup gönderin.)</em></p>
<p>Kime: {{trader.legal_name}}<span data-if="trader.address">, {{trader.address}}</span>, <a href="mailto:{{trader.email}}">{{trader.email}}</a></p>
<ul>
<li>İşbu formla, aşağıdaki ürünlerin satışına (*)/aşağıdaki hizmetin sunulmasına (*) ilişkin sözleşmemden/sözleşmemizden (*) caydığımı/caydığımızı (*) bildiririm/bildiririz (*):</li>
<li>Sipariş tarihi (*)/teslim alma tarihi (*):</li>
<li>Tüketicinin/tüketicilerin adı:</li>
<li>Tüketicinin/tüketicilerin adresi:</li>
<li>Tüketicinin/tüketicilerin imzası (yalnızca form kâğıt üzerinde gönderiliyorsa):</li>
<li>Tarih:</li>
</ul>
<p>(*) Uygun olmayanı çiziniz.</p>
`,
  },
};

/* ------------------------------------------------------------------ */
/* Shipping policy                                                     */
/* ------------------------------------------------------------------ */

const SHIPPING: LocalizedTemplates = {
  sv: {
    title: 'Leveransvillkor',
    html: `
<h2>1. Leveransområde</h2>
<p>{{store.name}} levererar till de länder som kan väljas i kassan. Om ditt land inte går att välja kan vi för närvarande inte leverera dit.</p>
<h2>2. Leveranssätt och fraktkostnad</h2>
<p>Tillgängliga leveranssätt och fraktkostnader visas i kassan innan du bekräftar ditt köp. Eventuella erbjudanden om fri frakt framgår också där.</p>
<h2>3. Leveranstid</h2>
<p>Beräknad leveranstid anges på produktsidan eller i kassan och är en uppskattning. Om ingen leveranstid har avtalats levererar vi utan onödigt dröjsmål och senast inom 30 dagar från beställningen. Blir leveransen försenad meddelar vi dig. Är förseningen väsentlig har du rätt att häva köpet och få tillbaka hela beloppet.</p>
<h2>4. Spårning</h2>
<p>När ordern har skickats får du en bekräftelse via e-post, med spårningsinformation när transportföretaget erbjuder det.</p>
<h2>5. Mottagande och ej uthämtade paket</h2>
<p>Hämta ditt paket inom den tid som transportföretaget anger. Paket som inte hämtas ut skickas tillbaka till oss. Vi får då debitera de faktiska kostnader som detta orsakar oss, till exempel frakt och returfrakt. Om du vill ångra köpet, meddela oss i stället enligt <a href="/legal/refund">Ångerrätt och returer</a>.</p>
<h2>6. Risken för varan</h2>
<p>Vi står risken för varan tills du, eller någon som du har utsett, har tagit emot den. Om varan försvinner eller skadas under transporten till dig är det alltså vårt ansvar.</p>
<h2>7. Skadade eller försvunna paket</h2>
<p>Kontrollera paketet när du tar emot det. Om förpackningen är synligt skadad, anmäl det gärna till transportföretaget vid mottagandet och kontakta oss så snart som möjligt på <a href="mailto:{{trader.email}}">{{trader.email}}</a> med ordernummer och bilder. Spara förpackningen tills ärendet är löst. Om ditt paket inte har kommit fram inom den angivna leveranstiden, kontakta oss så utreder vi saken med transportföretaget och skickar en ny vara eller återbetalar dig.</p>
<h2>8. Leveranser utanför EU</h2>
<p>Vid leveranser till länder utanför EU kan tull, importmoms och avgifter tas ut av myndigheter eller transportföretag i mottagarlandet. Dessa betalas av dig, om det inte anges i kassan att de ingår i priset. Om ett paket inte löses ut på grund av obetalda avgifter får vi göra avdrag för de kostnader detta orsakar oss.</p>
<h2>9. Frågor</h2>
<p>Har du frågor om din leverans är du välkommen att kontakta oss på <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> eller på telefon {{trader.phone}}</span>.</p>
`,
  },
  en: {
    title: 'Shipping Policy',
    html: `
<h2>1. Delivery area</h2>
<p>{{store.name}} delivers to the countries that can be selected at checkout. If your country cannot be selected, we are currently unable to deliver there.</p>
<h2>2. Delivery methods and shipping costs</h2>
<p>The available delivery methods and shipping costs are shown at checkout before you confirm your purchase. Any free shipping offers are also shown there.</p>
<h2>3. Delivery times</h2>
<p>The estimated delivery time is stated on the product page or at checkout and is an estimate. If no delivery time has been agreed, we deliver without undue delay and no later than 30 days after your order. If your delivery is delayed we will let you know. If the delay is significant you have the right to cancel the purchase and receive a full refund.</p>
<h2>4. Tracking</h2>
<p>When your order has been shipped you receive a confirmation by email, with tracking information where the carrier provides it.</p>
<h2>5. Receiving your parcel and unclaimed parcels</h2>
<p>Please collect your parcel within the time stated by the carrier. Unclaimed parcels are returned to us, and we may then charge the actual costs this causes us, such as shipping and return shipping. If you want to withdraw from your purchase, please notify us instead as described under <a href="/legal/refund">Returns and right of withdrawal</a>.</p>
<h2>6. Risk for the goods</h2>
<p>We bear the risk for the goods until you, or someone you have appointed, have received them. If the goods are lost or damaged in transit to you, that is our responsibility.</p>
<h2>7. Damaged or missing parcels</h2>
<p>Check your parcel when you receive it. If the packaging is visibly damaged, please report it to the carrier on receipt and contact us as soon as possible at <a href="mailto:{{trader.email}}">{{trader.email}}</a> with your order number and photos. Keep the packaging until the matter is resolved. If your parcel has not arrived within the stated delivery time, contact us and we will investigate with the carrier and send a replacement or refund you.</p>
<h2>8. Deliveries outside the EU</h2>
<p>For deliveries to countries outside the EU, customs duties, import VAT and fees may be charged by authorities or the carrier in the destination country. These are paid by you, unless it is stated at checkout that they are included in the price. If a parcel is not collected because of unpaid charges, we may deduct the costs this causes us.</p>
<h2>9. Questions</h2>
<p>If you have questions about your delivery, please contact us at <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> or by phone on {{trader.phone}}</span>.</p>
`,
  },
  de: {
    title: 'Versand und Lieferung',
    html: `
<h2>1. Liefergebiet</h2>
<p>{{store.name}} liefert in die Länder, die im Checkout ausgewählt werden können. Ist Ihr Land nicht auswählbar, können wir derzeit nicht dorthin liefern.</p>
<h2>2. Versandarten und Versandkosten</h2>
<p>Die verfügbaren Versandarten und Versandkosten werden im Checkout angezeigt, bevor Sie Ihren Kauf bestätigen. Etwaige Angebote für kostenlosen Versand sind dort ebenfalls angegeben.</p>
<h2>3. Lieferzeiten</h2>
<p>Die voraussichtliche Lieferzeit ist auf der Produktseite oder im Checkout angegeben und ist eine Schätzung. Wurde keine Lieferzeit vereinbart, liefern wir ohne unangemessene Verzögerung und spätestens 30 Tage nach Ihrer Bestellung. Verzögert sich Ihre Lieferung, informieren wir Sie. Ist die Verzögerung erheblich, können Sie vom Kauf zurücktreten und erhalten den vollen Betrag zurück.</p>
<h2>4. Sendungsverfolgung</h2>
<p>Sobald Ihre Bestellung versandt wurde, erhalten Sie eine Bestätigung per E-Mail, mit Sendungsverfolgung, sofern der Versanddienstleister diese anbietet.</p>
<h2>5. Empfang und nicht abgeholte Pakete</h2>
<p>Bitte holen Sie Ihr Paket innerhalb der vom Versanddienstleister angegebenen Frist ab. Nicht abgeholte Pakete werden an uns zurückgesandt; wir können Ihnen dann die tatsächlich entstandenen Kosten, etwa für Hin- und Rücksendung, berechnen. Wenn Sie Ihren Kauf widerrufen möchten, teilen Sie uns dies bitte stattdessen wie unter <a href="/legal/refund">Widerrufsrecht und Rücksendungen</a> beschrieben mit.</p>
<h2>6. Gefahrübergang</h2>
<p>Wir tragen die Gefahr für die Ware, bis Sie oder eine von Ihnen benannte Person sie erhalten haben. Geht die Ware auf dem Transport zu Ihnen verloren oder wird sie beschädigt, liegt dies in unserer Verantwortung.</p>
<h2>7. Beschädigte oder verlorene Pakete</h2>
<p>Prüfen Sie Ihr Paket bei Erhalt. Ist die Verpackung sichtbar beschädigt, melden Sie dies bitte bei der Zustellung dem Versanddienstleister und kontaktieren Sie uns so schnell wie möglich unter <a href="mailto:{{trader.email}}">{{trader.email}}</a> mit Bestellnummer und Fotos. Bewahren Sie die Verpackung auf, bis der Fall geklärt ist. Ist Ihr Paket nicht innerhalb der angegebenen Lieferzeit angekommen, kontaktieren Sie uns; wir klären den Fall mit dem Versanddienstleister und senden Ihnen Ersatz oder erstatten den Betrag.</p>
<h2>8. Lieferungen außerhalb der EU</h2>
<p>Bei Lieferungen in Länder außerhalb der EU können Zölle, Einfuhrumsatzsteuer und Gebühren von Behörden oder dem Versanddienstleister im Empfängerland erhoben werden. Diese tragen Sie, sofern im Checkout nicht angegeben ist, dass sie im Preis enthalten sind. Wird ein Paket wegen unbezahlter Gebühren nicht angenommen, können wir die uns dadurch entstehenden Kosten abziehen.</p>
<h2>9. Fragen</h2>
<p>Bei Fragen zu Ihrer Lieferung kontaktieren Sie uns gern unter <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> oder telefonisch unter {{trader.phone}}</span>.</p>
`,
  },
  fr: {
    title: 'Livraison',
    html: `
<h2>1. Zone de livraison</h2>
<p>{{store.name}} livre dans les pays pouvant être sélectionnés lors du paiement. Si votre pays ne peut pas être sélectionné, nous ne sommes actuellement pas en mesure d’y livrer.</p>
<h2>2. Modes et frais de livraison</h2>
<p>Les modes de livraison disponibles et les frais de livraison sont affichés lors du paiement, avant la confirmation de votre achat. Les éventuelles offres de livraison gratuite y sont également indiquées.</p>
<h2>3. Délais de livraison</h2>
<p>Le délai de livraison estimé est indiqué sur la page du produit ou lors du paiement et constitue une estimation. Si aucun délai n’a été convenu, nous livrons sans retard injustifié et au plus tard 30 jours après votre commande. En cas de retard, nous vous en informons. Si le retard est important, vous avez le droit d’annuler l’achat et d’être intégralement remboursé(e).</p>
<h2>4. Suivi</h2>
<p>Lorsque votre commande est expédiée, vous recevez une confirmation par e-mail, accompagnée d’un numéro de suivi lorsque le transporteur le propose.</p>
<h2>5. Réception et colis non retirés</h2>
<p>Veuillez retirer votre colis dans le délai indiqué par le transporteur. Les colis non retirés nous sont renvoyés ; nous pouvons alors vous facturer les frais réels que cela nous occasionne, comme les frais d’envoi et de retour. Si vous souhaitez vous rétracter, informez-nous plutôt comme indiqué dans <a href="/legal/refund">Droit de rétractation et retours</a>.</p>
<h2>6. Transfert des risques</h2>
<p>Nous supportons les risques liés aux produits jusqu’à ce que vous-même, ou une personne que vous avez désignée, les ayez reçus. Si les produits sont perdus ou endommagés pendant le transport, cela relève de notre responsabilité.</p>
<h2>7. Colis endommagés ou perdus</h2>
<p>Vérifiez votre colis à sa réception. Si l’emballage est visiblement endommagé, signalez-le au transporteur lors de la réception et contactez-nous dès que possible à <a href="mailto:{{trader.email}}">{{trader.email}}</a> en indiquant votre numéro de commande et en joignant des photos. Conservez l’emballage jusqu’au règlement du dossier. Si votre colis n’est pas arrivé dans le délai indiqué, contactez-nous : nous enquêterons auprès du transporteur et vous enverrons un produit de remplacement ou vous rembourserons.</p>
<h2>8. Livraisons hors de l’UE</h2>
<p>Pour les livraisons vers des pays hors de l’UE, des droits de douane, une TVA à l’importation et des frais peuvent être perçus par les autorités ou le transporteur du pays de destination. Ils sont à votre charge, sauf s’il est indiqué lors du paiement qu’ils sont inclus dans le prix. Si un colis n’est pas retiré en raison de frais impayés, nous pouvons déduire les coûts que cela nous occasionne.</p>
<h2>9. Questions</h2>
<p>Pour toute question concernant votre livraison, contactez-nous à <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> ou par téléphone au {{trader.phone}}</span>.</p>
`,
  },
  ar: {
    title: 'الشحن والتوصيل',
    html: `
<h2>1. مناطق التوصيل</h2>
<p>يوصّل {{store.name}} إلى الدول التي يمكن اختيارها في صفحة الدفع. وإذا لم يكن بلدك متاحاً للاختيار، فلا يمكننا التوصيل إليه حالياً.</p>
<h2>2. طرق التوصيل وتكاليف الشحن</h2>
<p>تظهر طرق التوصيل المتاحة وتكاليف الشحن في صفحة الدفع قبل تأكيد الشراء، وكذلك أي عروض للشحن المجاني.</p>
<h2>3. مواعيد التوصيل</h2>
<p>يُذكر موعد التوصيل التقديري في صفحة المنتج أو في صفحة الدفع، وهو موعد تقريبي. وإذا لم يُتّفق على موعد للتوصيل، فإننا نسلّم دون تأخير غير مبرر وفي موعد أقصاه 30 يوماً من تاريخ الطلب. وإذا تأخّر التوصيل نبلغك بذلك، وإذا كان التأخير جوهرياً يحق لك فسخ الشراء واسترداد المبلغ كاملاً.</p>
<h2>4. تتبّع الشحنة</h2>
<p>عند شحن طلبك تتلقّى تأكيداً عبر البريد الإلكتروني، مع معلومات التتبّع متى وفّرتها شركة الشحن.</p>
<h2>5. استلام الطرد والطرود غير المستلَمة</h2>
<p>يُرجى استلام طردك خلال المدة التي تحدّدها شركة الشحن. وتُعاد الطرود غير المستلَمة إلينا، ويجوز لنا عندئذٍ مطالبتك بالتكاليف الفعلية التي تكبّدناها، مثل تكلفة الشحن وإعادة الشحن. وإذا كنت ترغب في العدول عن الشراء، فأبلغنا بذلك بدلاً من ترك الطرد، كما هو موضّح في <a href="/legal/refund">حق العدول والإرجاع</a>.</p>
<h2>6. تبعة المخاطر</h2>
<p>نتحمّل نحن تبعة المخاطر المتعلقة بالمنتج إلى أن تستلمه أنت أو من تعيّنه لذلك. فإذا فُقد المنتج أو تلف أثناء نقله إليك، فذلك من مسؤوليتنا.</p>
<h2>7. الطرود التالفة أو المفقودة</h2>
<p>افحص طردك عند استلامه. وإذا كانت العبوة تالفة بشكل ظاهر، فيُرجى إبلاغ شركة الشحن عند الاستلام والتواصل معنا في أقرب وقت عبر <a href="mailto:{{trader.email}}">{{trader.email}}</a> مع رقم الطلب وصور. واحتفظ بالعبوة إلى أن تُحلّ المسألة. وإذا لم يصل طردك خلال موعد التوصيل المذكور، تواصل معنا وسنتحقق من الأمر مع شركة الشحن ونرسل إليك بديلاً أو نعيد إليك المبلغ.</p>
<h2>8. التوصيل خارج الاتحاد الأوروبي</h2>
<p>عند التوصيل إلى دول خارج الاتحاد الأوروبي، قد تفرض السلطات أو شركة الشحن في بلد الوجهة رسوماً جمركية وضريبة استيراد ورسوماً أخرى. وتتحمّلها أنت، ما لم يُذكر في صفحة الدفع أنها مشمولة في السعر. وإذا لم يُستلم الطرد بسبب رسوم غير مدفوعة، يجوز لنا خصم التكاليف التي تكبّدناها نتيجة ذلك.</p>
<h2>9. الاستفسارات</h2>
<p>إذا كانت لديك أسئلة حول التوصيل، يسعدنا تواصلك معنا عبر <a href="mailto:{{trader.email}}">{{trader.email}}</a><span data-if="trader.phone"> أو على الهاتف {{trader.phone}}</span>.</p>
`,
  },
  tr: {
    title: 'Kargo ve Teslimat',
    html: `
<h2>1. Teslimat bölgesi</h2>
<p>{{store.name}}, ödeme sayfasında seçilebilen ülkelere teslimat yapar. Ülkeniz seçilemiyorsa şu anda oraya teslimat yapamıyoruz.</p>
<h2>2. Teslimat yöntemleri ve kargo ücretleri</h2>
<p>Kullanılabilir teslimat yöntemleri ve kargo ücretleri, satın alımınızı onaylamadan önce ödeme sayfasında gösterilir. Varsa ücretsiz kargo teklifleri de orada belirtilir.</p>
<h2>3. Teslimat süreleri</h2>
<p>Tahmini teslimat süresi ürün sayfasında veya ödeme sayfasında belirtilir ve bir tahmindir. Bir teslimat süresi kararlaştırılmamışsa gereksiz gecikme olmaksızın ve en geç siparişten itibaren 30 gün içinde teslim ederiz. Teslimatınız gecikirse sizi bilgilendiririz. Gecikme önemliyse satın alımı iptal etme ve tutarın tamamını geri alma hakkınız vardır.</p>
<h2>4. Kargo takibi</h2>
<p>Siparişiniz kargoya verildiğinde, kargo şirketi sunuyorsa takip bilgisiyle birlikte e-posta ile bir onay alırsınız.</p>
<h2>5. Paketin teslim alınması ve teslim alınmayan paketler</h2>
<p>Lütfen paketinizi kargo şirketinin belirttiği süre içinde teslim alın. Teslim alınmayan paketler bize geri gönderilir; bu durumda gönderim ve geri gönderim gibi bize doğan gerçek masrafları sizden talep edebiliriz. Satın alımdan caymak istiyorsanız lütfen bunun yerine <a href="/legal/refund">Cayma Hakkı ve İadeler</a> sayfasında açıklandığı şekilde bize bildirin.</p>
<h2>6. Riskin geçişi</h2>
<p>Ürün, siz veya belirlediğiniz bir kişi tarafından teslim alınana kadar risk bize aittir. Ürün size taşınırken kaybolur veya hasar görürse bu bizim sorumluluğumuzdadır.</p>
<h2>7. Hasarlı veya kayıp paketler</h2>
<p>Paketinizi teslim alırken kontrol edin. Ambalaj gözle görülür şekilde hasarlıysa lütfen teslim sırasında kargo şirketine bildirin ve sipariş numaranız ile fotoğraflarla birlikte en kısa sürede <a href="mailto:{{trader.email}}">{{trader.email}}</a> adresinden bize ulaşın. Sorun çözülene kadar ambalajı saklayın. Paketiniz belirtilen teslimat süresi içinde ulaşmadıysa bizimle iletişime geçin; konuyu kargo şirketiyle araştırır, yerine yeni ürün gönderir veya ödemenizi iade ederiz.</p>
<h2>8. AB dışına teslimatlar</h2>
<p>AB dışındaki ülkelere yapılan teslimatlarda, varış ülkesindeki makamlar veya kargo şirketi gümrük vergisi, ithalat KDV'si ve çeşitli ücretler talep edebilir. Ödeme sayfasında fiyata dahil olduğu belirtilmedikçe bunları siz ödersiniz. Bir paket ödenmemiş ücretler nedeniyle teslim alınmazsa bundan doğan masrafları düşebiliriz.</p>
<h2>9. Sorular</h2>
<p>Teslimatınızla ilgili sorularınız için <a href="mailto:{{trader.email}}">{{trader.email}}</a> adresinden<span data-if="trader.phone"> veya {{trader.phone}} numaralı telefondan</span> bize ulaşabilirsiniz.</p>
`,
  },
};

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export const STORE_LEGAL_TEMPLATES: Record<StoreLegalSlug, LocalizedTemplates> =
  {
    privacy: PRIVACY,
    terms: TERMS,
    refund: REFUND,
    shipping: SHIPPING,
  };
