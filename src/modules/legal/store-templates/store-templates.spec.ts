import {
  STORE_LEGAL_KIND,
  STORE_LEGAL_SLUGS,
  escapeHtml,
  fillStoreTemplate,
  pickTemplate,
} from './store-templates';
import { STORE_LEGAL_TEMPLATES } from './templates.data';
import { sanitizeCreatorHtml } from '../../../common/html/creator-html';
import {
  platformSellerContext,
  trackingTemplateContext,
} from '../store-legal.service';
import {
  hasVisibleText,
  pickPageTitle,
  resolveLegalPage,
  type LegalLegacyRow,
  type LegalV2Row,
} from './store-legal-resolver';

describe('store legal template constants', () => {
  it('fixed slug order and kind mapping', () => {
    expect(STORE_LEGAL_SLUGS).toEqual([
      'privacy',
      'terms',
      'refund',
      'shipping',
    ]);
    expect(STORE_LEGAL_KIND).toEqual({
      privacy: 'PRIVACY_POLICY',
      terms: 'TERMS',
      refund: 'RETURN_POLICY',
      shipping: 'SHIPPING_POLICY',
    });
  });

  it('every slug has an English template', () => {
    for (const slug of STORE_LEGAL_SLUGS) {
      expect(STORE_LEGAL_TEMPLATES[slug].en?.html).toBeTruthy();
    }
  });
});

describe('pickTemplate', () => {
  it('uses the locale when present, else English', () => {
    const en = pickTemplate('privacy', 'xx');
    expect(en?.locale).toBe('en');
    expect(pickTemplate('privacy', 'EN-gb')?.locale).toBe('en');
    expect(pickTemplate('privacy', null)?.locale).toBe('en');
  });
});

describe('fillStoreTemplate', () => {
  it('HTML-escapes every value', () => {
    const out = fillStoreTemplate(
      '<p>{{trader.legal_name}} – {{ store.name }}</p>',
      {
        'trader.legal_name': '<script>alert("x")</script> & Co',
        'store.name': "O'Hara",
      },
    );
    expect(out).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co – O&#39;Hara</p>',
    );
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('missing, unknown and blank values become empty', () => {
    expect(
      fillStoreTemplate(
        '<p>[{{trader.phone}}][{{nope.key}}][{{trader.email}}]</p>',
        {
          'trader.email': '   ',
        },
      ),
    ).toBe('<p>[][][]</p>');
  });

  it('data-if: removed when the value is empty, unwrapped when set', () => {
    const html =
      '<p>Org {{trader.org_number}}.<span data-if="trader.vat_number"> VAT {{trader.vat_number}}.</span></p>';
    expect(fillStoreTemplate(html, { 'trader.org_number': '556' })).toBe(
      '<p>Org 556.</p>',
    );
    expect(
      fillStoreTemplate(html, {
        'trader.org_number': '556',
        'trader.vat_number': 'SE556',
      }),
    ).toBe('<p>Org 556. VAT SE556.</p>');
  });

  it('data-if: nested spans, single quotes and several conditionals', () => {
    const html =
      '<p><span data-if=\'trader.phone\'>Call {{trader.phone}}<span data-if="trader.vat_number"> / {{trader.vat_number}}</span>.</span><span data-if="trader.email"> Mail {{trader.email}}</span></p>';
    expect(fillStoreTemplate(html, { 'trader.phone': '070' })).toBe(
      '<p>Call 070.</p>',
    );
    expect(
      fillStoreTemplate(html, {
        'trader.phone': '070',
        'trader.vat_number': 'SE1',
        'trader.email': 'a@b.se',
      }),
    ).toBe('<p>Call 070 / SE1. Mail a@b.se</p>');
    // A paragraph emptied by its conditionals is dropped.
    expect(fillStoreTemplate(html, {})).toBe('');
  });

  it('a value containing a placeholder is not expanded again', () => {
    expect(
      fillStoreTemplate('{{store.name}}', {
        'store.name': '{{trader.email}}',
        'trader.email': 'x',
      }),
    ).toBe('{{trader.email}}');
  });
});

function v2(over: Partial<LegalV2Row> = {}): LegalV2Row {
  return {
    id: 'v2-privacy',
    slug: 'privacy-policy',
    static_kind: 'PRIVACY_POLICY',
    published_version_id: 'ver1',
    updated_at: new Date('2026-11-01T00:00:00Z'),
    translations: [{ locale: 'sv', title: 'Integritet' }],
    published_version: { published_at: new Date('2026-11-02T00:00:00Z') },
    published_meta: {
      section_count: 1,
      titles: [{ locale: 'sv', title: 'Integritet' }],
    },
    ...over,
  };
}

function legacy(over: Partial<LegalLegacyRow> = {}): LegalLegacyRow {
  return {
    id: 'legacy-privacy',
    slug: 'integritetspolicy',
    type: 'PRIVACY_POLICY',
    status: 'PUBLISHED',
    updated_at: new Date('2026-10-01T00:00:00Z'),
    translations: [{ locale: 'sv', title: 'Policy', content: '<p>Text</p>' }],
    ...over,
  };
}

describe('resolveLegalPage', () => {
  it('a published v2 page wins over a published legacy page', () => {
    const r = resolveLegalPage('privacy', { v2: [v2()], legacy: [legacy()] });
    expect(r).toMatchObject({
      state: 'published',
      system: 'v2',
      page: { id: 'v2-privacy', slug: 'privacy-policy' },
    });
    expect(r.page?.updated_at).toEqual(new Date('2026-11-02T00:00:00Z'));
  });

  it('a draft v2 page falls back to the published legacy page', () => {
    const r = resolveLegalPage('privacy', {
      v2: [
        v2({
          published_version_id: null,
          published_version: null,
          published_meta: null,
        }),
      ],
      legacy: [legacy()],
    });
    expect(r).toMatchObject({
      state: 'published',
      system: 'legacy',
      page: { id: 'legacy-privacy' },
    });
  });

  it('a published v2 snapshot without sections is no own page', () => {
    const r = resolveLegalPage('privacy', {
      v2: [
        v2({
          published_meta: { section_count: 0, titles: [] },
        }),
      ],
      legacy: [],
    });
    expect(r.state).toBe('draft');
  });

  it('a legacy page empty in every locale, or a draft, is not published', () => {
    const empty = resolveLegalPage('privacy', {
      v2: [],
      legacy: [
        legacy({
          translations: [
            { locale: 'sv', title: 'P', content: '<p>&nbsp;</p>' },
          ],
        }),
      ],
    });
    expect(empty).toMatchObject({ state: 'draft', system: 'legacy' });
    const draft = resolveLegalPage('privacy', {
      v2: [],
      legacy: [legacy({ status: 'DRAFT' })],
    });
    expect(draft.state).toBe('draft');
  });

  it('nothing of the kind → none (other kinds are ignored)', () => {
    const r = resolveLegalPage('terms', { v2: [v2()], legacy: [legacy()] });
    expect(r).toEqual({ state: 'none', system: null, page: null });
  });

  it('published v2: titles from the snapshot, else the live translations', () => {
    const page = v2({
      translations: [{ locale: 'sv', title: 'Utkast' }],
      published_meta: {
        section_count: 1,
        titles: [{ locale: 'sv', title: 'Publicerad' }],
      },
    });
    expect(
      resolveLegalPage('privacy', { v2: [page], legacy: [] }).page?.titles,
    ).toEqual([{ locale: 'sv', title: 'Publicerad' }]);
    const blankSnapshotTitles = v2({
      translations: [{ locale: 'sv', title: 'Utkast' }],
      published_meta: {
        section_count: 1,
        titles: [{ locale: 'sv', title: ' ' }],
      },
    });
    expect(
      resolveLegalPage('privacy', { v2: [blankSnapshotTitles], legacy: [] })
        .page?.titles,
    ).toEqual([{ locale: 'sv', title: 'Utkast' }]);
    // A draft shows its live titles.
    const draft = v2({
      published_version_id: null,
      published_version: null,
      published_meta: null,
      translations: [{ locale: 'sv', title: 'Utkast' }],
    });
    expect(
      resolveLegalPage('privacy', { v2: [draft], legacy: [] }).page?.titles,
    ).toEqual([{ locale: 'sv', title: 'Utkast' }]);
  });

  it('pickPageTitle: case-insensitive, then base language, then any', () => {
    const titles = [
      { locale: 'sv', title: 'SV' },
      { locale: 'pt-BR', title: 'PT' },
    ];
    expect(pickPageTitle(titles, ['PT-br'])).toBe('PT');
    expect(pickPageTitle(titles, ['pt'])).toBe('PT');
    expect(pickPageTitle(titles, ['SV'])).toBe('SV');
    expect(pickPageTitle(titles, ['de', null])).toBe('SV');
    expect(pickPageTitle([], ['sv'])).toBeNull();
  });

  it('hasVisibleText', () => {
    expect(hasVisibleText('<p> </p>')).toBe(false);
    expect(hasVisibleText(null)).toBe(false);
    expect(hasVisibleText('<p>a</p>')).toBe(true);
  });
});

describe('every shipped template fills and sanitizes cleanly', () => {
  const full = {
    'trader.legal_name': 'Anna Handel AB',
    'trader.org_number': '556016-0680',
    'trader.vat_number': 'SE556016068001',
    'trader.address': 'Gatan 1, 111 22 Stockholm, Sweden',
    'trader.email': 'help@anna.se',
    'trader.phone': '+46701234567',
    'store.name': 'Anna',
    'store.url': 'https://anna.se',
    'seller.is_independent': '1',
    'seller.is_platform': '',
    // Every tracker configured, so every vendor paragraph (and link) renders.
    'tracking.ga4': '1',
    'tracking.meta': '1',
    'tracking.tiktok': '1',
    'tracking.clarity': '1',
    'tracking.any': '1',
    'tracking.gated': '1',
  };
  const minimal = { ...full, 'trader.vat_number': '', 'trader.phone': '' };
  const cases = STORE_LEGAL_SLUGS.flatMap((slug) =>
    Object.keys(STORE_LEGAL_TEMPLATES[slug]).map(
      (locale) => [slug, locale] as const,
    ),
  );

  it.each(cases)('%s / %s', (slug, locale) => {
    const tpl = STORE_LEGAL_TEMPLATES[slug][locale as 'en'];
    expect(tpl?.title).toBeTruthy();
    for (const ctx of [full, minimal]) {
      const filled = fillStoreTemplate(tpl!.html, ctx);
      const out = sanitizeCreatorHtml(filled) ?? '';
      expect(out).not.toContain('{{');
      expect(out).not.toContain('}}');
      expect(out).not.toContain('data-if');
      expect(filled).not.toContain('data-if');
      if (ctx === minimal) {
        expect(out).not.toContain('SE556016068001');
        expect(out).not.toContain('+46701234567');
      }
      // Links the sanitizer must keep: relative /legal/*, https and mailto.
      for (const href of tpl!.html.match(/href="([^"{]+)"/g) ?? []) {
        expect(out).toContain(href);
      }
      if (tpl!.html.includes('href="mailto:{{trader.email}}"')) {
        expect(out).toContain('href="mailto:help@anna.se"');
      }
    }
  });
});

/** Placeholders, data-if keys and hrefs of a template, sorted (a multiset). */
function structure(html: string) {
  const all = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1]).sort();
  return {
    placeholders: all(/\{\{\s*([\w.]+)\s*\}\}/g),
    dataIf: all(/data-if=["']([\w.]+)["']/g),
    hrefs: all(/href="([^"]*)"/g),
  };
}

/**
 * Deliberate per-locale link differences: the Swedish terms point to
 * Konsumenteuropa (the Swedish ECC); the other locales address residents of
 * other EU countries (their own ECC via ECC-Net, no Swedish link).
 */
const EXTRA_HREFS: Partial<Record<string, Partial<Record<string, string[]>>>> =
  {
    terms: { sv: ['https://www.konsumenteuropa.se'] },
  };

describe('template parity with English', () => {
  const cases = STORE_LEGAL_SLUGS.flatMap((slug) =>
    Object.keys(STORE_LEGAL_TEMPLATES[slug])
      .filter((l) => l !== 'en')
      .map((locale) => [slug, locale] as const),
  );

  it('all six locales exist for every document', () => {
    for (const slug of STORE_LEGAL_SLUGS) {
      expect(Object.keys(STORE_LEGAL_TEMPLATES[slug]).sort()).toEqual([
        'ar',
        'de',
        'en',
        'fr',
        'sv',
        'tr',
      ]);
    }
  });

  it.each(cases)(
    '%s / %s: same placeholders, data-if keys and hrefs',
    (slug, locale) => {
      const en = structure(STORE_LEGAL_TEMPLATES[slug].en!.html);
      const other = structure(
        STORE_LEGAL_TEMPLATES[slug][locale as 'en']!.html,
      );
      const extra = EXTRA_HREFS[slug]?.[locale] ?? [];
      expect(other.placeholders).toEqual(en.placeholders);
      expect(other.dataIf).toEqual(en.dataIf);
      expect(other.hrefs).toEqual([...en.hrefs, ...extra].sort());
    },
  );
});

describe('templates with empty required trader fields (older stores)', () => {
  const sparse = {
    // legal_name falls back to the store name (StoreLegalService).
    'trader.legal_name': 'Anna',
    'trader.org_number': '',
    'trader.vat_number': '',
    'trader.address': '',
    'trader.email': 'help@anna.se',
    'trader.phone': '',
    'store.name': 'Anna',
    'store.url': 'https://anna.se',
    'seller.is_independent': '1',
    'seller.is_platform': '',
  };
  const cases = STORE_LEGAL_SLUGS.flatMap((slug) =>
    Object.keys(STORE_LEGAL_TEMPLATES[slug]).map(
      (locale) => [slug, locale] as const,
    ),
  );

  it.each(cases)('%s / %s reads cleanly', (slug, locale) => {
    const tpl = STORE_LEGAL_TEMPLATES[slug][locale as 'en']!;
    const out = sanitizeCreatorHtml(fillStoreTemplate(tpl.html, sparse)) ?? '';
    const text = out.replace(/<[^>]*>/g, ' ');
    expect(out).not.toMatch(/<(p|li)>\s*<\/\1>/);
    expect(text).not.toMatch(/[,،]\s*[,.،]/);
    expect(text).not.toMatch(
      /(org\.nr|reg\. no\.|Org\.-Nr\.|immatriculation|sicil no\.|رقم التسجيل)\s*[,.;،]/,
    );
    expect(text).not.toMatch(/(Adress|Address|Adresse|Adres|العنوان)\s*:\s*$/m);
  });
});

/**
 * Wording that is only valid when the seller is not Namez AB: the platform
 * provider (processor) bullet and the sub-processor label, per locale.
 */
const INDEPENDENT_ONLY: Record<string, string[]> = {
  sv: ['Plattformsleverantör', 'personuppgiftsbiträdesavtal', 'Underbiträden'],
  en: ['Platform provider', 'on our behalf as our processor', 'Sub-processors'],
  de: ['Plattformanbieter', 'in unserem Auftrag', 'Unterauftragsverarbeiter'],
  fr: [
    'Fournisseur de la plateforme',
    'pour notre compte',
    'Sous-traitants ultérieurs',
  ],
  ar: ['مزوّد المنصة', 'المعالجون الفرعيون'],
  tr: ['Platform sağlayıcısı', 'bizim adımıza', 'Alt işleyenler'],
};

describe('seller conditionals', () => {
  const cases = STORE_LEGAL_SLUGS.flatMap((slug) =>
    Object.keys(STORE_LEGAL_TEMPLATES[slug]).map(
      (locale) => [slug, locale] as const,
    ),
  );

  it.each(cases)(
    '%s / %s: marketplace (Namez AB as seller)',
    (slug, locale) => {
      const tpl = STORE_LEGAL_TEMPLATES[slug][locale as 'en']!;
      const ctx = platformSellerContext(
        { name: 'Influencer Store', url: 'https://influencer.shopsdoor.com' },
        'hello@shopsdoor.com',
        locale,
      );
      const filled = fillStoreTemplate(tpl.html, ctx);
      const out = sanitizeCreatorHtml(filled) ?? '';
      const text = out.replace(/<[^>]*>/g, ' ');
      expect(out).not.toContain('{{');
      expect(filled).not.toContain('data-if');
      expect(out).not.toMatch(/<(p|li)>\s*<\/\1>/);
      expect(text).not.toMatch(/[,،]\s*[,.،]/);
      for (const phrase of INDEPENDENT_ONLY[locale] ?? []) {
        expect(text).not.toContain(phrase);
      }
      // No Borlänge office as fallback return address.
      if (slug === 'refund') {
        expect(text.split('Hagavägen').length - 1).toBeLessThanOrEqual(1);
      }
      // The shipping policy names no seller.
      if (slug !== 'shipping') expect(text).toContain('Namez AB');
    },
  );

  it('privacy names Namez AB as the controller for marketplace stores', () => {
    const ctx = platformSellerContext(
      { name: 'Influencer Store', url: 'https://influencer.shopsdoor.com' },
      'hello@shopsdoor.com',
      'sv',
    );
    const out = fillStoreTemplate(STORE_LEGAL_TEMPLATES.privacy.sv!.html, ctx);
    expect(out).toContain(
      'Namez AB, org.nr 559295-1007, Hagavägen 36, 784 40 Borlänge, Sverige, är personuppgiftsansvarig',
    );
    expect(out).toContain('som är säljare och personuppgiftsansvarig');
  });

  it('independent stores keep the processor bullet', () => {
    const out = fillStoreTemplate(STORE_LEGAL_TEMPLATES.privacy.en!.html, {
      'trader.legal_name': 'Anna AB',
      'seller.is_independent': '1',
    });
    expect(out).toContain('Platform provider (processor)');
    expect(out).not.toContain('which is the seller and the controller');
  });
});

/** Vendor names that must appear only when the store configured them. */
const VENDORS = {
  ga4: 'Google Analytics',
  meta: 'Meta Pixel',
  tiktok: 'TikTok Pixel',
  clarity: 'Microsoft Clarity',
} as const;

describe('privacy cookie section: tracking vendors', () => {
  const base = {
    'trader.legal_name': 'Anna AB',
    'trader.email': 'help@anna.se',
    'store.name': 'Anna',
    'store.url': 'https://anna.se',
    'seller.is_independent': '1',
    'seller.is_platform': '',
  };
  const locales = Object.keys(STORE_LEGAL_TEMPLATES.privacy);

  it.each(locales)('%s: no tracker configured → no vendor, no US-transfer note', (locale) => {
    const html = STORE_LEGAL_TEMPLATES.privacy[locale as 'en']!.html;
    const out =
      sanitizeCreatorHtml(
        fillStoreTemplate(html, { ...base, ...trackingTemplateContext({}) }),
      ) ?? '';
    for (const name of Object.values(VENDORS)) expect(out).not.toContain(name);
    expect(out).not.toContain('_clck');
    expect(out).not.toContain('privacy.microsoft.com');
    expect(out).not.toMatch(/<(p|li)>\s*<\/\1>/);
  });

  it.each(locales)('%s: only Clarity configured → only Clarity is named, with cookies, retention and the US transfer', (locale) => {
    const html = STORE_LEGAL_TEMPLATES.privacy[locale as 'en']!.html;
    const ctx = {
      ...base,
      ...trackingTemplateContext({ clarity_project_id: 'sxtuobatm6' }),
    };
    const out = sanitizeCreatorHtml(fillStoreTemplate(html, ctx)) ?? '';
    expect(out).toContain(VENDORS.clarity);
    expect(out).toContain('_clck');
    expect(out).toContain('_clsk');
    expect(out).toContain('MUID');
    expect(out).toContain('30');
    expect(out).toContain('href="https://privacy.microsoft.com/privacystatement"');
    expect(out).toMatch(/Data Privacy Framework/);
    for (const name of [VENDORS.ga4, VENDORS.meta, VENDORS.tiktok]) {
      expect(out).not.toContain(name);
    }
    // The project id itself is never printed.
    expect(out).not.toContain('sxtuobatm6');
  });

  it('GA4 + Meta configured (Namez today) → both named, Clarity and TikTok not', () => {
    const out = fillStoreTemplate(STORE_LEGAL_TEMPLATES.privacy.sv!.html, {
      ...base,
      ...trackingTemplateContext({
        ga4_measurement_id: 'G-0LQ8TWPC6V',
        meta_pixel_id: '1064861581891343',
        tiktok_pixel_id: null,
        clarity_project_id: '  ',
      }),
    });
    expect(out).toContain(VENDORS.ga4);
    expect(out).toContain(VENDORS.meta);
    expect(out).not.toContain(VENDORS.clarity);
    expect(out).not.toContain(VENDORS.tiktok);
  });

  it('trackingTemplateContext flags', () => {
    expect(trackingTemplateContext({})).toEqual({
      'tracking.ga4': '',
      'tracking.meta': '',
      'tracking.tiktok': '',
      'tracking.clarity': '',
      'tracking.any': '',
      'tracking.gated': '',
      'tracking.ungated': '',
    });
    expect(
      trackingTemplateContext({ clarity_project_id: 'sxtuobatm6' }),
    ).toMatchObject({
      'tracking.clarity': '1',
      'tracking.any': '1',
      'tracking.gated': '1',
      'tracking.ungated': '',
    });
    // Clarity alone always waits for consent, even with consent_required off.
    expect(
      trackingTemplateContext({
        clarity_project_id: 'sxtuobatm6',
        consent_required: false,
      }),
    ).toMatchObject({ 'tracking.gated': '1', 'tracking.ungated': '' });
    expect(
      trackingTemplateContext({
        ga4_measurement_id: 'G-1',
        consent_required: false,
      }),
    ).toMatchObject({ 'tracking.gated': '', 'tracking.ungated': '1' });
  });

  // Sentence "loaded only after Accept all" per locale, and the marker of the
  // ungated alternative ("load on visit").
  const GATED: Record<string, string> = {
    sv: 'De laddas först när du väljer',
    en: 'They are loaded only after you choose',
    de: 'Sie werden erst geladen',
    fr: 'Ils ne sont chargés qu’après',
    ar: 'ولا تُحمَّل إلا بعد اختيارك',
    tr: 'Bu hizmetler yalnızca',
  };
  const UNGATED: Record<string, string> = {
    sv: 'laddas när du besöker butiken',
    en: 'are loaded when you visit the store',
    de: 'beim Besuch des Shops geladen',
    fr: 'sont chargés dès votre visite',
    ar: 'عند زيارتك للمتجر',
    tr: 'mağazayı ziyaret ettiğinizde yüklenir',
  };

  it.each(locales)('%s: consent_required off → no "only after Accept all" promise for GA/Meta/TikTok', (locale) => {
    const html = STORE_LEGAL_TEMPLATES.privacy[locale as 'en']!.html;
    const fill = (consent_required: boolean) =>
      sanitizeCreatorHtml(
        fillStoreTemplate(html, {
          ...base,
          ...trackingTemplateContext({
            ga4_measurement_id: 'G-1',
            clarity_project_id: 'sxtuobatm6',
            consent_required,
          }),
        }),
      ) ?? '';
    const off = fill(false);
    expect(off).not.toContain(GATED[locale]);
    expect(off).toContain(UNGATED[locale]);
    const on = fill(true);
    expect(on).toContain(GATED[locale]);
    expect(on).not.toContain(UNGATED[locale]);
  });
});
