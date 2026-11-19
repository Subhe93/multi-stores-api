import {
  PLATFORM_EMAIL_BRAND,
  PLATFORM_EMAIL_LOCALES,
  buildOnboardingTemplates,
  buildPlatformEmailTemplates,
  toTemplateColumns,
} from '../platform-email-templates';
import { NotificationTemplatesService } from '../../src/modules/notification-templates/notification-templates.service';
import { knownOldTemplateSets } from './platform-email-templates-sync.legacy';
import {
  buildPlan,
  countPlan,
  fingerprint,
  isNoop,
  missingPlaceholders,
  parseArgs,
  placeholdersOf,
  planEvent,
  renderPlan,
  selectEvents,
  type DbTemplateRow,
  type EventPlan,
  type Options,
} from './platform-email-templates-sync.planner';

const DEFAULTS = buildPlatformEmailTemplates();
const KNOWN_OLD = knownOldTemplateSets();
const GEN1 = KNOWN_OLD[0].texts;
const GEN2 = KNOWN_OLD[1].texts;

const ORDER_EVENTS = [
  'order_confirmation',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'order_refunded',
  'new_order_owner',
];

const opts = (over: Partial<Options> = {}): Options => ({
  mode: 'dry-run',
  force: false,
  events: null,
  fingerprint: null,
  ...over,
});

/** A DB row holding the given event -> locale texts. */
const rowOf = (
  event: string,
  perLocale: Record<
    string,
    { subject: string; body_html: string; body_text: string }
  >,
  enabled = true,
): DbTemplateRow => ({ event, ...toTemplateColumns(perLocale), enabled });

const localeOf = (e: EventPlan, locale: string) =>
  e.locales.find((l) => l.locale === locale)!;
const statuses = (e: EventPlan, locale: string) =>
  localeOf(e, locale).fields.map((f) => f.status);

// ── The defaults themselves ─────────────────────────────────────────────────

describe('platform default email templates', () => {
  it('defines every event in the platform locales (onboarding: all but ku), with no empty text', () => {
    const onboarding = new Set(Object.keys(buildOnboardingTemplates()));
    expect(Object.keys(DEFAULTS)).toEqual(
      expect.arrayContaining([
        'password_reset',
        ...ORDER_EVENTS,
        'welcome',
        'account_created',
        'email_verification',
        'backup_offsite_missing',
      ]),
    );
    for (const [event, perLocale] of Object.entries(DEFAULTS)) {
      // Seller-facing onboarding events are not translated into Kurdish.
      const expected = onboarding.has(event)
        ? PLATFORM_EMAIL_LOCALES.filter((l) => l !== 'ku')
        : [...PLATFORM_EMAIL_LOCALES];
      expect([event, Object.keys(perLocale)]).toEqual([event, expected]);
      for (const t of Object.values(perLocale)) {
        expect(t.subject.trim()).not.toBe('');
        expect(t.body_html.trim()).not.toBe('');
        expect(t.body_text.trim()).not.toBe('');
      }
    }
  });

  it('every order event carries the items blocks in every locale', () => {
    for (const event of ORDER_EVENTS) {
      for (const loc of PLATFORM_EMAIL_LOCALES) {
        expect(DEFAULTS[event][loc].body_html).toContain('{{items_html}}');
        expect(DEFAULTS[event][loc].body_text).toContain('{{items_text}}');
        expect(DEFAULTS[event][loc].body_text).not.toContain('{{items_html}}');
      }
    }
  });

  it('uses only variables the event receives (EVENT_CATALOG)', () => {
    const catalog = new Map(
      NotificationTemplatesService.EVENT_CATALOG.map((e) => [
        e.event,
        new Set(e.variables),
      ]),
    );
    for (const [event, perLocale] of Object.entries(DEFAULTS)) {
      const allowed = catalog.get(event);
      expect([event, Boolean(allowed)]).toEqual([event, true]);
      for (const [loc, t] of Object.entries(perLocale)) {
        const used = new Set([
          ...placeholdersOf(t.subject),
          ...placeholdersOf(t.body_html),
          ...placeholdersOf(t.body_text),
        ]);
        // The shared account / onboarding layout names the store in its
        // footer; events without a store render it empty (as seeded before).
        used.delete('store_name');
        const unknown = [...used].filter((v) => !allowed!.has(v));
        expect([event, loc, unknown]).toEqual([event, loc, []]);
      }
    }
  });

  it('every locale of an event uses the same placeholders and markup as en', () => {
    const tags = (html: string): string[] =>
      Array.from(html.match(/<[^>]+>/g) ?? [], (t: string) =>
        // dir="rtl" is the one allowed markup difference (Arabic).
        t.replace(' dir="rtl"', ''),
      );
    for (const [event, perLocale] of Object.entries(DEFAULTS)) {
      for (const loc of Object.keys(perLocale)) {
        for (const field of ['subject', 'body_html', 'body_text'] as const) {
          expect([
            event,
            loc,
            field,
            placeholdersOf(perLocale[loc][field]).sort(),
          ]).toEqual([
            event,
            loc,
            field,
            placeholdersOf(perLocale.en[field]).sort(),
          ]);
        }
        expect([event, loc, tags(perLocale[loc].body_html)]).toEqual([
          event,
          loc,
          tags(perLocale.en.body_html),
        ]);
      }
    }
  });

  it('names ShopsDoor, never the old brand', () => {
    expect(PLATFORM_EMAIL_BRAND).toBe('ShopsDoor');
    const all = JSON.stringify(DEFAULTS);
    expect(all).not.toContain('Multi Stores');
    for (const loc of PLATFORM_EMAIL_LOCALES) {
      expect(DEFAULTS.order_confirmation[loc].body_html).toContain(
        '<p style="font-size:11px;color:#a1a1aa;text-align:center;margin-top:16px;">ShopsDoor</p>',
      );
    }
  });

  it('keeps the en order confirmation byte-identical to the seeded version', () => {
    expect(DEFAULTS.order_confirmation.en).toEqual({
      subject: 'Order {{order_number}} confirmed',
      body_html: [
        '<!doctype html>',
        '<html>',
        '  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">',
        '    <div style="max-width:480px;margin:0 auto;padding:24px;">',
        '      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">',
        '        <h1 style="font-size:18px;margin:0 0 16px;">Thanks for your order!</h1>',
        '        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Your order <strong>{{order_number}}</strong> has been placed. {{payment_line}}</p>',
        '           {{items_html}}',
        '           <p style="font-size:14px;color:#3f3f46;">Total: <strong>{{total}}</strong></p>',
        '           {{order_button}}',
        '      </div>',
        '      <p style="font-size:11px;color:#a1a1aa;text-align:center;margin-top:16px;">ShopsDoor</p>',
        '    </div>',
        '  </body>',
        '</html>',
      ].join('\n'),
      body_text:
        'Thanks for your order!\n\nOrder {{order_number}} has been placed. {{payment_line}}\n{{items_text}}\nTotal: {{total}}{{order_url_text}}',
    });
  });

  it('backup_offsite_missing substitutes its own variables and has the button', () => {
    for (const loc of Object.keys(DEFAULTS.backup_offsite_missing)) {
      const t = DEFAULTS.backup_offsite_missing[loc];
      expect(t.body_html).not.toMatch(
        /(^|[^{])\{(bucket|last_success|hours_since|checked_at)\}/,
      );
      expect(t.body_html).toContain('{{bucket}}');
      expect(t.body_html).toContain('href="{{admin_url}}"');
      expect(t.body_text).toContain('{{admin_url}}');
    }
  });
});

// ── Known old defaults ──────────────────────────────────────────────────────

describe('known old defaults', () => {
  it('generation 1 is the old order confirmation: Multi Stores, no items', () => {
    for (const loc of ['en', 'ar']) {
      const t = GEN1.order_confirmation[loc];
      expect(t.body_html).toContain('>Multi Stores</p>');
      expect(t.body_html).not.toContain('{{items_html}}');
      expect(t.body_text).not.toContain('{{items_text}}');
    }
    expect(GEN1.order_confirmation.en.body_text).toBe(
      'Thanks for your order!\n\nOrder {{order_number}} has been placed. {{payment_line}}\nTotal: {{total}}{{order_url_text}}',
    );
    expect(Object.keys(GEN1)).toEqual(['password_reset', 'order_confirmation']);
  });

  it('generation 2 differs from the current en / ar defaults by the brand only', () => {
    expect(Object.keys(GEN2)).toEqual([
      'password_reset',
      ...ORDER_EVENTS,
      'welcome',
    ]);
    for (const [event, perLocale] of Object.entries(GEN2)) {
      expect(Object.keys(perLocale)).toEqual(['en', 'ar']);
      for (const [loc, t] of Object.entries(perLocale)) {
        for (const field of ['subject', 'body_html', 'body_text'] as const) {
          expect(t[field].split('Multi Stores').join('ShopsDoor')).toBe(
            DEFAULTS[event][loc][field],
          );
        }
      }
    }
  });

  it('no old text equals a current default (it would be pointless to list)', () => {
    for (const set of KNOWN_OLD) {
      for (const [event, perLocale] of Object.entries(set.texts)) {
        for (const [loc, t] of Object.entries(perLocale)) {
          expect([
            event,
            loc,
            t.body_html === DEFAULTS[event][loc].body_html,
          ]).toEqual([event, loc, false]);
        }
      }
    }
  });
});

// ── Arguments ───────────────────────────────────────────────────────────────

describe('parseArgs / selectEvents', () => {
  it('is a safe-merge dry run by default', () => {
    expect(parseArgs([])).toEqual(opts());
  });

  it('reads --apply, --force, --events, --fingerprint and ignores --backup-dir', () => {
    expect(
      parseArgs([
        '--apply',
        '--force',
        '--events=order_confirmation, welcome,order_confirmation',
        '--fingerprint',
        'abc',
        '--backup-dir=/tmp/x',
      ]),
    ).toEqual({
      mode: 'apply',
      force: true,
      events: ['order_confirmation', 'welcome'],
      fingerprint: 'abc',
    });
  });

  it('rejects unknown arguments, an empty list and unknown events', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument');
    expect(() => parseArgs(['--events='])).toThrow('at least one event');
    expect(() =>
      selectEvents(DEFAULTS, opts({ events: ['order_confirmation', 'nope'] })),
    ).toThrow('Unknown event(s): nope');
  });

  it('keeps the order of the defaults and restricts the plan to --events', () => {
    const o = opts({ events: ['welcome', 'order_confirmation'] });
    expect(selectEvents(DEFAULTS, o)).toEqual([
      'order_confirmation',
      'welcome',
    ]);
    const plan = buildPlan(DEFAULTS, [], KNOWN_OLD, o);
    expect(plan.events.map((e) => e.event)).toEqual([
      'order_confirmation',
      'welcome',
    ]);
    expect(selectEvents(DEFAULTS, opts())).toEqual(Object.keys(DEFAULTS));
  });
});

// ── Placeholders ────────────────────────────────────────────────────────────

describe('placeholders', () => {
  it('reads plain and conditional placeholders once each', () => {
    expect(
      placeholdersOf(
        '{{#if name}}Hi {{ name }}{{/if}}{{#unless name}}Hi{{/unless}} {{total}} {single}',
      ),
    ).toEqual(['name', 'total']);
  });

  it('lists what a stored text lacks compared with the default', () => {
    expect(
      missingPlaceholders(
        GEN1.order_confirmation.en.body_html,
        DEFAULTS.order_confirmation.en.body_html,
      ),
    ).toEqual(['items_html']);
    expect(
      missingPlaceholders(
        GEN1.order_confirmation.en.body_text,
        DEFAULTS.order_confirmation.en.body_text,
      ),
    ).toEqual(['items_text']);
  });
});

// ── Merge rules ─────────────────────────────────────────────────────────────

describe('safe merge', () => {
  const event = 'order_confirmation';
  const wanted = DEFAULTS[event];

  it('creates a missing row with every locale', () => {
    const e = planEvent(event, wanted, null, KNOWN_OLD, false);
    expect(e.rowMissing).toBe(true);
    expect(e.action).toBe('create');
    expect(e.locales.map((l) => l.state)).toEqual(
      PLATFORM_EMAIL_LOCALES.map(() => 'missing'),
    );
    expect(e.next).toEqual(toTemplateColumns(wanted));
  });

  it('the production case: old en/ar are replaced, the four other locales added', () => {
    const row = rowOf(event, GEN1[event], false);
    const e = planEvent(event, wanted, row, KNOWN_OLD, false);
    expect(e.action).toBe('update');
    // The subject never changed between the generations.
    expect(statuses(e, 'en')).toEqual(['same', 'replace-old', 'replace-old']);
    expect(statuses(e, 'ar')).toEqual(['same', 'replace-old', 'replace-old']);
    expect(localeOf(e, 'en').state).toBe('update');
    expect(localeOf(e, 'en').fields[1]).toMatchObject({
      oldLabel: KNOWN_OLD[0].label,
      missingPlaceholders: ['items_html'],
    });
    for (const loc of ['tr', 'de', 'fr', 'sv', 'ku'])
      expect(localeOf(e, loc).state).toBe('missing');
    expect(e.next).toEqual(toTemplateColumns(wanted));
    // `enabled` is not part of what is written.
    expect(Object.keys(e.next!)).toEqual(['subject', 'body_html', 'body_text']);
  });

  it('recognises the second generation (Multi Stores, with items) too', () => {
    const e = planEvent(
      event,
      wanted,
      rowOf(event, GEN2[event]),
      KNOWN_OLD,
      false,
    );
    expect(statuses(e, 'en')).toEqual(['same', 'replace-old', 'same']);
    expect(localeOf(e, 'en').fields[1].oldLabel).toBe(KNOWN_OLD[1].label);
    expect(localeOf(e, 'en').fields[1].missingPlaceholders).toEqual([]);
  });

  it('keeps an admin-edited text and reports the placeholders it lacks', () => {
    const edited = {
      ...GEN1[event].en,
      body_html: GEN1[event].en.body_html.replace(
        'Thanks for your order!',
        'Thank you so much!',
      ),
    };
    const row = rowOf(event, { en: edited, ar: GEN1[event].ar });
    const e = planEvent(event, wanted, row, KNOWN_OLD, false);
    expect(statuses(e, 'en')).toEqual(['same', 'keep-edited', 'replace-old']);
    expect(localeOf(e, 'en').state).toBe('kept');
    expect(localeOf(e, 'en').fields[1].missingPlaceholders).toEqual([
      'items_html',
    ]);
    // The edited html is carried over untouched; the old text is replaced.
    expect(e.next!.body_html.en).toBe(edited.body_html);
    expect(e.next!.body_text.en).toBe(wanted.en.body_text);
    expect(e.next!.body_html.ar).toBe(wanted.ar.body_html);

    const report = renderPlan({ force: false, events: [e] }, 'dry-run');
    expect(report).toContain(
      'en: KEPT (looks admin-edited; use --force to overwrite)',
    );
    expect(report).toContain(
      'body_html: differs, not a known old default -> KEEP (looks admin-edited); stored text lacks {{items_html}}',
    );
    expect(report).toContain(
      'Kept because they look admin-edited (1): order_confirmation/en',
    );
    expect(report).toContain(
      'order_confirmation/en/body_html lacks {{items_html}}',
    );
    // Texts are never printed.
    expect(report).not.toContain('Thank you so much!');
  });

  it('a row that only has edited texts is not written at all', () => {
    const custom = { subject: 'S', body_html: '<p>H</p>', body_text: 'T' };
    const perLocale = Object.fromEntries(
      PLATFORM_EMAIL_LOCALES.map((l) => [l, custom]),
    );
    const e = planEvent(
      event,
      wanted,
      rowOf(event, perLocale),
      KNOWN_OLD,
      false,
    );
    expect(e.action).toBe('none');
    expect(e.next).toBeNull();
    expect(e.locales.every((l) => l.state === 'kept')).toBe(true);
  });

  it('an up-to-date row is a no-op (idempotent), CRLF and outer blanks ignored', () => {
    const crlf = Object.fromEntries(
      Object.entries(wanted).map(([loc, t]) => [
        loc,
        {
          subject: t.subject,
          body_html: `${t.body_html.replace(/\n/g, '\r\n')}\r\n`,
          body_text: ` ${t.body_text}`,
        },
      ]),
    );
    const e = planEvent(event, wanted, rowOf(event, crlf), KNOWN_OLD, false);
    expect(e.action).toBe('none');
    expect(e.locales.every((l) => l.state === 'same')).toBe(true);

    const plan = buildPlan(
      DEFAULTS,
      Object.entries(DEFAULTS).map(([ev, per]) => rowOf(ev, per)),
      KNOWN_OLD,
      opts(),
    );
    expect(isNoop(plan)).toBe(true);
    expect(countPlan(plan).fieldsWritten).toBe(0);
  });

  it('fills an empty field of an existing locale and keeps unknown locales', () => {
    const row = rowOf(event, {
      ...wanted,
      sv: { ...wanted.sv, body_text: '' },
      es: { subject: 'Pedido', body_html: '<p>es</p>', body_text: 'es' },
    });
    const e = planEvent(event, wanted, row, KNOWN_OLD, false);
    expect(statuses(e, 'sv')).toEqual(['same', 'same', 'add']);
    expect(e.extraLocales).toEqual(['es']);
    expect(e.next!.body_text.sv).toBe(wanted.sv.body_text);
    expect(e.next!.body_html.es).toBe('<p>es</p>');
    expect(e.next!.subject.es).toBe('Pedido');
  });

  it('survives rows with broken JSON columns and never drops a non-string value', () => {
    const row: DbTemplateRow = {
      event,
      subject: null,
      body_html: 'not an object',
      body_text: { en: 42 },
    };
    const e = planEvent(event, wanted, row, KNOWN_OLD, false);
    expect(statuses(e, 'en')).toEqual(['add', 'add', 'keep-edited']);
    expect(e.next!.body_text.en).toBe(42);
    expect(e.next!.body_html.en).toBe(wanted.en.body_html);
  });

  it('replaces the backup_offsite_missing row seeded with single-brace tokens', () => {
    const ev = 'backup_offsite_missing';
    const e = planEvent(
      ev,
      DEFAULTS[ev],
      rowOf(ev, KNOWN_OLD[2].texts[ev]),
      KNOWN_OLD,
      false,
    );
    expect(statuses(e, 'en')).toEqual(['same', 'replace-old', 'replace-old']);
    expect(localeOf(e, 'en').fields[1].missingPlaceholders).toEqual(
      expect.arrayContaining(['bucket', 'admin_url']),
    );
  });
});

// ── Force ───────────────────────────────────────────────────────────────────

describe('--force', () => {
  const event = 'order_confirmation';
  const custom = { subject: 'S', body_html: '<p>H</p>', body_text: 'T' };
  const rows = [
    rowOf(event, { en: custom, es: custom }),
    rowOf('welcome', { en: custom }),
  ];

  it('overwrites edited texts of the selected events only', () => {
    const plan = buildPlan(
      DEFAULTS,
      rows,
      KNOWN_OLD,
      opts({ force: true, events: [event] }),
    );
    expect(plan.events.map((e) => e.event)).toEqual([event]);
    const e = plan.events[0];
    expect(statuses(e, 'en')).toEqual([
      'replace-forced',
      'replace-forced',
      'replace-forced',
    ]);
    expect(localeOf(e, 'en').state).toBe('forced');
    expect(e.next).toEqual({
      subject: { ...toTemplateColumns(DEFAULTS[event]).subject, es: 'S' },
      body_html: {
        ...toTemplateColumns(DEFAULTS[event]).body_html,
        es: '<p>H</p>',
      },
      body_text: { ...toTemplateColumns(DEFAULTS[event]).body_text, es: 'T' },
    });
    expect(renderPlan(plan, 'dry-run')).toContain('en: OVERWRITE (--force)');
  });

  it('without --force the same rows are kept, and the fingerprint differs', () => {
    const merge = buildPlan(
      DEFAULTS,
      rows,
      KNOWN_OLD,
      opts({ events: [event] }),
    );
    const force = buildPlan(
      DEFAULTS,
      rows,
      KNOWN_OLD,
      opts({ force: true, events: [event] }),
    );
    expect(statuses(merge.events[0], 'en')).toEqual([
      'keep-edited',
      'keep-edited',
      'keep-edited',
    ]);
    expect(merge.events[0].next!.body_html.en).toBe('<p>H</p>');
    expect(fingerprint(merge)).not.toBe(fingerprint(force));
    expect(fingerprint(merge)).toBe(
      fingerprint(
        buildPlan(DEFAULTS, rows, KNOWN_OLD, opts({ events: [event] })),
      ),
    );
  });
});

// ── Report ──────────────────────────────────────────────────────────────────

describe('report', () => {
  it('names missing rows, missing locales, old defaults and the summary', () => {
    const plan = buildPlan(
      DEFAULTS,
      [rowOf('order_confirmation', GEN1.order_confirmation)],
      KNOWN_OLD,
      opts({ events: ['order_confirmation', 'welcome'] }),
    );
    const report = renderPlan(plan, 'dry-run');
    expect(report).toContain('order_confirmation: update');
    expect(report).toContain('  sv: MISSING LOCALE -> add');
    expect(report).toContain(
      `    body_html: old default -> replace [${KNOWN_OLD[0].label}]; stored text lacks {{items_html}}`,
    );
    expect(report).toContain('welcome: ROW MISSING -> create (enabled)');
    expect(report).toContain(
      'Summary: rows create 1, update 1, untouched 0; locales add 12, update 2, kept as admin-edited 0',
    );
    expect(report).not.toContain('Kept because');
    expect(countPlan(plan)).toMatchObject({
      rowsCreated: 1,
      rowsUpdated: 1,
      localesAdded: 12,
      localesUpdated: 2,
      fieldsWritten: 4 + 36,
    });
  });
});
