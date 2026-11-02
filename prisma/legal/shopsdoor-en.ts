// English legal texts for the ShopsDoor platform (operated by Namez AB, Sweden).
// Plain HTML without classes: the storefront renders it inside `.sd-prose`, and
// admins can edit it later from the dashboard. Values not public yet are
// marked with [PLACEHOLDERS] so they are easy to find and fill in.

const COMPANY = 'Namez AB';
const BRAND = 'ShopsDoor';
const EMAIL = 'hello@shopsdoor.com';
const ORG = '[ORGANISATION NUMBER]';
const ADDRESS = '[REGISTERED ADDRESS]';
const UPDATED = '2 November 2026';

const mail = `<a href="mailto:${EMAIL}">${EMAIL}</a>`;

export const terms = `
<p><em>Last updated: ${UPDATED}</em></p>

<h2>1. Who we are</h2>
<p>${BRAND} (<a href="https://shopsdoor.com">shopsdoor.com</a>) is a platform for building and running independent online stores. It is owned and operated by <strong>${COMPANY}</strong>, a limited company registered in Sweden with organisation number ${ORG} and registered address ${ADDRESS} (&ldquo;${COMPANY}&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). You can reach us at ${mail}.</p>
<p>These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the ${BRAND} platform, dashboard, storefronts and related services (together, the &ldquo;Service&rdquo;). By creating an account or using the Service you agree to these Terms. If you act on behalf of a company, you confirm that you are authorised to bind that company.</p>

<h2>2. Definitions</h2>
<ul>
  <li><strong>Seller</strong> &ndash; a person or company that creates a store on ${BRAND} and sells goods or services through it.</li>
  <li><strong>Customer</strong> &ndash; a person who visits or buys from a store hosted on ${BRAND}.</li>
  <li><strong>Store</strong> &ndash; an online shop created and operated by a Seller using the Service.</li>
  <li><strong>Content</strong> &ndash; text, images, product data, prices, policies and any other material uploaded to the Service.</li>
</ul>

<h2>3. Accounts</h2>
<p>You must be at least 18 years old and able to enter into a binding contract to open a Seller account. You are responsible for keeping your login credentials confidential, for enabling the security features we offer (such as two-factor authentication) and for all activity under your account. Tell us immediately at ${mail} if you suspect unauthorised use.</p>
<p>You must provide accurate information about yourself and your business and keep it up to date, including the legal details shown to your Customers as required by applicable consumer law.</p>

<h2>4. The Service</h2>
<p>${BRAND} provides the tools to build a storefront, manage products and orders, accept payments and sell in several markets, languages and currencies. We may add, change or remove features over time. Features marked as &ldquo;coming soon&rdquo; are not part of the Service until they are released.</p>
<p>We aim for high availability but do not guarantee that the Service will be uninterrupted or error-free. Planned maintenance is announced where reasonably possible.</p>

<h2>5. Sellers and their Customers</h2>
<p>Each Store is operated by its Seller. <strong>The Seller, not ${COMPANY}, is the merchant of record</strong> and the contracting party for every sale made through the Store. The Seller alone is responsible for:</p>
<ul>
  <li>the products and services offered, their legality, quality, safety, description and pricing;</li>
  <li>shipping, delivery, returns, refunds, warranties and customer service;</li>
  <li>taxes, VAT, invoicing and all regulatory obligations that apply to the Seller&rsquo;s sales;</li>
  <li>publishing its own terms, privacy information and shipping/return policies to Customers;</li>
  <li>obtaining all rights needed for the Content it uploads.</li>
</ul>
<p>${COMPANY} is a technology provider and is not a party to the contract between a Seller and a Customer.</p>

<h2>6. Payments and Stripe</h2>
<p>Payments on ${BRAND} are processed by <strong>Stripe</strong>. To accept payments, a Seller connects or creates a Stripe account and accepts the <a href="https://stripe.com/legal/connect-account">Stripe Connected Account Agreement</a> and Stripe&rsquo;s terms. <strong>Payouts for sales are made by Stripe directly to the Seller&rsquo;s own Stripe account</strong>; ${COMPANY} does not hold Seller funds. Stripe&rsquo;s payment processing fees are charged by Stripe at its standard rates and are separate from any ${BRAND} subscription fee.</p>
<p>Chargebacks, disputes and refunds relating to a Seller&rsquo;s sales are the Seller&rsquo;s responsibility and are handled through the Seller&rsquo;s Stripe account.</p>

<h2>7. Subscriptions, fees and cancellation</h2>
<p>Some parts of the Service require a paid subscription. Plans and prices are shown on shopsdoor.com or in the dashboard before you subscribe; prices are stated in SEK or EUR, excluding VAT where applicable. Subscriptions renew automatically for the same period until cancelled.</p>
<p>You may <strong>cancel at any time</strong> from the dashboard or by emailing ${mail}. Cancellation takes effect at the end of the current paid period; you keep access until then. <strong>Fees already paid for the current period are not refunded</strong>, except where required by law or stated in our <a href="/legal/refund">Refund and Cancellation Policy</a>. We may change prices with at least 30 days&rsquo; notice; the new price applies from your next renewal.</p>
<p>If a payment fails, we may suspend the paid features after a reasonable reminder and, if the fee remains unpaid, close the Store.</p>

<h2>8. Acceptable use</h2>
<p>You may not use the Service to sell or promote anything that is illegal, counterfeit, dangerous, that infringes third-party rights, or that is prohibited by Stripe&rsquo;s <a href="https://stripe.com/legal/restricted-businesses">restricted businesses list</a>. You may not upload malicious code, scrape the platform, attempt to access other accounts, send spam, or use the Service in a way that harms ${BRAND}, other Sellers or Customers.</p>
<p>We may remove Content, suspend or terminate accounts that breach these Terms, and we will inform you where the law allows.</p>

<h2>9. Content and intellectual property</h2>
<p>You keep all rights to the Content you upload. You grant ${COMPANY} a non-exclusive, worldwide licence to host, display, reproduce and adapt that Content only as needed to operate, secure and improve the Service (for example, generating image sizes or caching pages).</p>
<p>The ${BRAND} platform, its software, design, themes, logos and trademarks belong to ${COMPANY} or its licensors. Nothing in these Terms transfers those rights to you. You may use the ${BRAND} name and badge to indicate that your Store is hosted on ${BRAND}, and not otherwise without our written consent.</p>

<h2>10. Personal data</h2>
<p>How we process personal data is described in our <a href="/legal/privacy">Privacy Policy</a>. For Customer data processed inside a Store, the Seller is the controller and ${COMPANY} processes that data on the Seller&rsquo;s behalf as processor; the data processing terms in the Privacy Policy form part of these Terms.</p>

<h2>11. Term, termination and data export</h2>
<p>These Terms apply for as long as you have an account. You may close your account at any time. We may terminate or suspend your account with reasonable notice, or immediately for a serious breach, unlawful activity, a Stripe compliance requirement or a legal obligation.</p>
<p>After termination you can request an export of your products, orders and customers for 30 days; after that we may delete your Store data, subject to legal retention duties.</p>

<h2>12. Warranties and liability</h2>
<p>The Service is provided &ldquo;as is&rdquo;. To the extent permitted by law, ${COMPANY} disclaims all implied warranties and is not liable for indirect or consequential losses, lost profits, lost data or business interruption. Our total liability for all claims in any twelve-month period is limited to the fees you paid to ${COMPANY} for the Service in that period.</p>
<p>Nothing in these Terms limits liability for intent, gross negligence, personal injury or any liability that cannot be limited under mandatory law, including mandatory consumer protection law where you are a consumer.</p>

<h2>13. Changes to these Terms</h2>
<p>We may update these Terms. Material changes are announced by email or in the dashboard at least 30 days before they take effect, unless a change is required by law or concerns a new feature. Continued use after the effective date means you accept the updated Terms.</p>

<h2>14. Governing law and disputes</h2>
<p>These Terms are governed by the laws of <strong>Sweden</strong>, excluding its conflict-of-law rules. Disputes are brought before the Swedish courts, with Stockholm District Court (Stockholms tingsrätt) as first instance, unless mandatory law gives you the right to a court in your home country. Consumers in the EU may also use the European Commission&rsquo;s online dispute resolution platform at <a href="https://ec.europa.eu/consumers/odr">ec.europa.eu/consumers/odr</a>.</p>

<h2>15. Contact</h2>
<p>${COMPANY}, ${ADDRESS}, Sweden &ndash; organisation number ${ORG} &ndash; ${mail}.</p>
`.trim();

export const privacy = `
<p><em>Last updated: ${UPDATED}</em></p>

<h2>1. Controller</h2>
<p>${BRAND} is operated by <strong>${COMPANY}</strong>, organisation number ${ORG}, ${ADDRESS}, Sweden. ${COMPANY} is the data controller for the personal data described in this policy. Contact: ${mail}.</p>
<p>This policy explains how we process personal data when you visit shopsdoor.com, create a Seller account, or interact with a store hosted on ${BRAND}. Each Seller is a separate controller for the data of its own Customers (see section 7).</p>

<h2>2. What data we process</h2>
<ul>
  <li><strong>Account data</strong> &ndash; name, email address, password (hashed), language, two-factor settings, company details you enter.</li>
  <li><strong>Store data</strong> &ndash; store name, domains, products, settings and the content you publish.</li>
  <li><strong>Billing data</strong> &ndash; subscription plan, invoices and payment status. Card details are entered directly with Stripe and never reach our servers.</li>
  <li><strong>Usage and security data</strong> &ndash; IP address, device and browser information, login events, security events and server logs.</li>
  <li><strong>Communication</strong> &ndash; messages you send us through the contact form or by email.</li>
  <li><strong>Customer data processed for Sellers</strong> &ndash; names, addresses, email addresses, phone numbers, order history and payment status of a store&rsquo;s customers.</li>
</ul>

<h2>3. Why and on what legal basis</h2>
<ul>
  <li><strong>Providing the Service</strong> (account, store, dashboard, payments, support) &ndash; performance of a contract, Art. 6(1)(b) GDPR.</li>
  <li><strong>Billing and accounting</strong> &ndash; legal obligation (Swedish Accounting Act), Art. 6(1)(c).</li>
  <li><strong>Security, fraud prevention and abuse handling</strong> &ndash; legitimate interest, Art. 6(1)(f).</li>
  <li><strong>Service emails</strong> such as order notifications, password resets and important changes &ndash; performance of a contract.</li>
  <li><strong>Marketing emails</strong> &ndash; only with your consent, Art. 6(1)(a); you can withdraw it at any time.</li>
  <li><strong>Analytics cookies</strong> &ndash; consent, where used (see section 8).</li>
</ul>

<h2>4. Recipients and processors</h2>
<p>We share personal data only with providers that help us run the Service, under data processing agreements:</p>
<ul>
  <li><strong>Stripe</strong> &ndash; payment processing and Seller payouts. Stripe is an independent controller for the data it needs to process payments; see <a href="https://stripe.com/privacy">stripe.com/privacy</a>.</li>
  <li><strong>Hosting and infrastructure providers</strong> within the EU/EEA for servers, databases, backups and file storage.</li>
  <li><strong>Email delivery providers</strong> for transactional emails.</li>
  <li>Authorities, when we are legally obliged to disclose data.</li>
</ul>
<p>Where a provider processes data outside the EU/EEA, we rely on an adequacy decision or the EU Standard Contractual Clauses.</p>

<h2>5. Retention</h2>
<ul>
  <li>Account and store data: for as long as your account exists, then deleted within 90 days of closure unless we must keep it.</li>
  <li>Invoices and accounting records: 7 years after the end of the financial year, as required by Swedish law.</li>
  <li>Security and server logs: normally 12 months.</li>
  <li>Contact-form messages: up to 24 months after the matter is closed.</li>
  <li>Customer data inside a store: as instructed by the Seller, and deleted when the Seller deletes it or closes the store.</li>
</ul>

<h2>6. Your rights</h2>
<p>Under the GDPR you have the right to access, rectify and erase your personal data, to restrict or object to processing, to data portability, and to withdraw consent at any time without affecting earlier processing. Contact us at ${mail} and we will answer within one month. You also have the right to lodge a complaint with the Swedish Authority for Privacy Protection (Integritetsskyddsmyndigheten, <a href="https://www.imy.se">imy.se</a>) or the supervisory authority in your country.</p>

<h2>7. Customers of stores hosted on ${BRAND}</h2>
<p>When you buy from a store on ${BRAND}, the Seller who runs that store is the controller of your order data and decides why and how it is used. ${COMPANY} processes that data as the Seller&rsquo;s processor, solely to run the store (checkout, order emails, order history). Direct any request about your order data to the Seller first; we help the Seller fulfil it. Your payment is processed by Stripe.</p>

<h2>8. Cookies</h2>
<p>shopsdoor.com and the dashboard use <strong>strictly necessary cookies</strong> for login sessions, security (CSRF), language and consent preferences. Stores hosted on ${BRAND} use necessary cookies for the shopping cart and checkout. Optional analytics or marketing cookies are only set after you give consent through the cookie banner, where a Seller or we use them. You can withdraw consent through the banner or delete cookies in your browser; necessary cookies cannot be disabled without breaking the service.</p>

<h2>9. Security</h2>
<p>We protect data with encryption in transit (TLS), hashed passwords, optional two-factor authentication, access controls, audit logging and regular backups. No system is completely secure; tell us at ${mail} if you believe your data has been compromised.</p>

<h2>10. Children</h2>
<p>The Service is not directed at children under 16 and we do not knowingly collect their data.</p>

<h2>11. Changes</h2>
<p>We may update this policy. The date at the top shows the latest version; material changes are announced by email or in the dashboard.</p>

<h2>12. Contact</h2>
<p>${COMPANY}, ${ADDRESS}, Sweden &ndash; ${mail}.</p>
`.trim();

export const refund = `
<p><em>Last updated: ${UPDATED}</em></p>

<h2>1. Scope</h2>
<p>This policy covers <strong>subscriptions to the ${BRAND} platform</strong> purchased from <strong>${COMPANY}</strong> (organisation number ${ORG}, Sweden). It does <strong>not</strong> cover purchases you make from a store hosted on ${BRAND}: each Seller sets its own return and refund terms, which are published on that store. For a product you bought in a store, please contact the Seller.</p>

<h2>2. Cancelling a subscription</h2>
<p>You may cancel your ${BRAND} subscription at any time from the dashboard or by emailing ${mail}. Cancellation stops the next renewal; your store and paid features remain available until the end of the period you have already paid for.</p>

<h2>3. Refunds</h2>
<p>Subscription fees are charged in advance for each billing period. <strong>We do not refund the current paid period</strong> when you cancel, in whole or in part, unless one of the following applies:</p>
<ul>
  <li>mandatory law in your country gives you a right to a refund;</li>
  <li>you exercise the EU right of withdrawal described in section 4;</li>
  <li>we have made a billing error, in which case we correct it and refund any overcharge;</li>
  <li>we terminate the Service or your account for a reason not attributable to you, in which case we refund the unused part of the period.</li>
</ul>
<p>Refunds are made to the original payment method through Stripe, normally within 10 business days.</p>

<h2>4. 14-day right of withdrawal (consumers in the EU/EEA)</h2>
<p>If you subscribe as a <strong>consumer</strong> (not in the course of a business), you have the right to withdraw from the contract within 14 days of the day you subscribed, without giving any reason, in accordance with the Swedish Distance Contracts Act (lag 2005:59 om distansavtal och avtal utanför affärslokaler). To withdraw, send a clear statement to ${mail} before the period ends; you may use the standard withdrawal form provided by the Swedish Consumer Agency (Konsumentverket). If you asked us to start the Service during the withdrawal period, you pay a proportionate amount for the days used and we refund the rest within 14 days of your notice.</p>
<p>Most ${BRAND} subscribers are businesses; the right of withdrawal does not apply to business customers.</p>

<h2>5. Stripe fees</h2>
<p>Payment processing fees for sales in your store are charged by Stripe under Stripe&rsquo;s terms and are not refundable by ${COMPANY}.</p>

<h2>6. Contact</h2>
<p>${COMPANY}, ${ADDRESS}, Sweden &ndash; ${mail}.</p>
`.trim();

export const shipping = `
<p><em>Last updated: ${UPDATED}</em></p>

<h2>Shipping is set by each store</h2>
<p>${BRAND} is a platform operated by <strong>${COMPANY}</strong> that hosts independent online stores. <strong>${COMPANY} does not sell, stock or ship products.</strong> Every store on ${BRAND} is run by its own Seller, who decides the shipping methods, countries served, delivery times, costs and return procedures for its products.</p>

<h2>Where to find a store&rsquo;s shipping terms</h2>
<ul>
  <li>Shipping options and costs are shown in the store&rsquo;s checkout before you pay.</li>
  <li>The store&rsquo;s own shipping and return policy is linked in its footer or legal pages.</li>
  <li>For questions about a delivery, contact the Seller using the contact details on the store or in your order confirmation email.</li>
</ul>

<h2>${BRAND} subscriptions</h2>
<p>${BRAND} subscriptions are digital services delivered online; nothing is shipped. Access is activated immediately after sign-up or payment.</p>

<h2>Contact</h2>
<p>If you cannot reach a Seller, write to us at ${mail} and we will help you get in touch.</p>
`.trim();

export const SHOPSDOOR_LEGAL_EN = {
  terms: { title: 'Terms of Service', content: terms },
  privacy: { title: 'Privacy Policy', content: privacy },
  refund: { title: 'Refund and Cancellation Policy', content: refund },
  shipping: { title: 'Shipping Policy', content: shipping },
} as const;

export default { terms, privacy, refund, shipping };
