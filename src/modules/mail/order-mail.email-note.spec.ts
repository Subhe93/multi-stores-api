import { createHash } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { orderWithItemsInclude, renderOrderItems } from './order-mail.helpers';
import { MailService } from './mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';

// Headless booking E2.2: a product's `email_note` (per locale) is shown under
// its line in the order confirmation email only. Without the option, or when
// no product has a note, the items block is byte-identical (the golden hash
// of the M4.0 G0 / M4.2 WP10 specs).

const GOLDEN_SV =
  '04dcc078f173014c524d78dd5d994e51eaa1ba8cdb082c22d09304be6fa28f25';

const base = {
  quantity: 2,
  unit_price: 99.5,
  product: {
    translations: [
      { locale: 'en', title: 'Tee <b>' },
      { locale: 'sv', title: 'Tröja' },
    ],
    images: [{ url: '/uploads/a.webp' }],
  },
  variant: { options: { Color: 'Red', Size: 'M' }, images: [] },
};

function withNotes(notes: Record<string, string | null>) {
  return {
    ...base,
    product: {
      ...base.product,
      translations: base.product.translations.map((t) => ({
        ...t,
        email_note: notes[t.locale] ?? null,
      })),
    },
  };
}

function sha(s: { items_html: string; items_text: string }): string {
  return createHash('sha256')
    .update(s.items_html + '\u0000' + s.items_text)
    .digest('hex');
}

const render = (
  item: unknown,
  locale = 'sv',
  emailNotes?: boolean,
  primary?: string,
) =>
  renderOrderItems(
    [item] as never,
    'SEK',
    locale,
    'http://api',
    primary,
    undefined,
    emailNotes === undefined ? undefined : { emailNotes },
  );

describe('renderOrderItems email notes (headless booking E2.2)', () => {
  it('no notes: byte-identical with and without the option', () => {
    expect(sha(render(base))).toBe(GOLDEN_SV);
    expect(sha(render(base, 'sv', true))).toBe(GOLDEN_SV);
    expect(sha(render(withNotes({}), 'sv', true))).toBe(GOLDEN_SV);
    expect(sha(render(withNotes({ sv: '   ' }), 'sv', true))).toBe(GOLDEN_SV);
  });

  it('a note without the option (every other event) changes nothing', () => {
    const item = withNotes({ sv: 'Ta med glasögon' });
    expect(sha(render(item))).toBe(GOLDEN_SV);
    expect(sha(render(item, 'sv', false))).toBe(GOLDEN_SV);
  });

  it('shows the note under the qty line of its item, escaped', () => {
    const out = render(
      withNotes({ sv: 'Ta med <glasögon> & körkort' }),
      'sv',
      true,
    );
    const qty = out.items_html.indexOf('Antal: 2</div>');
    const note = out.items_html.indexOf(
      'Ta med &lt;glasögon&gt; &amp; körkort',
    );
    expect(qty).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(qty);
    expect(out.items_html).not.toContain('<glasögon>');
    // The text line ends with the amount, then the note on its own line.
    expect(out.items_text).toMatch(
      /× 2 — SEK\s199\.00\n {4}Ta med <glasögon> & körkort$/,
    );
  });

  it('multi-line note: one text line each, pre-line in HTML', () => {
    const out = render(withNotes({ sv: 'Rad 1\nRad 2' }), 'sv', true);
    expect(out.items_text).toContain('\n    Rad 1\n    Rad 2');
    expect(out.items_html).toContain(
      'white-space:pre-line;">Rad 1\nRad 2</div>',
    );
  });

  it('locale, then the store primary locale, then English', () => {
    const item = withNotes({ en: 'EN note', sv: 'SV note' });
    expect(render(item, 'sv', true).items_text).toContain('SV note');
    expect(render(item, 'en', true).items_text).toContain('EN note');
    // German email, primary sv: the sv note.
    const de = render(item, 'de', true, 'sv').items_text;
    expect(de).toContain('SV note');
    expect(de).not.toContain('EN note');
    // German email, no primary: English.
    expect(render(item, 'de', true).items_text).toContain('EN note');
    // Only another locale has a note: none shown.
    const onlyEn = withNotes({ en: 'EN only' });
    expect(render(onlyEn, 'sv', true, 'sv').items_text).toContain('EN only');
    const onlyAr = withNotes({ ar: 'AR only' });
    expect(render(onlyAr, 'sv', true, 'sv').items_text).not.toContain(
      'AR only',
    );
  });

  it('the mail include opts in to the globally omitted column', () => {
    expect(
      orderWithItemsInclude.items.include.product.include.translations,
    ).toEqual({ omit: { email_note: false } });
  });
});

describe('MailService order context: notes only for order_confirmation', () => {
  const order = {
    id: 'o1',
    order_number: 'ORD-1',
    currency: 'SEK',
    total: 199,
    shipping_cost: 0,
    shipping_method_name: null,
    items: [withNotes({ sv: 'Ta med glasögon' })],
    storeCtx: { id: 's1', slug: 'prima', name: 'Prima', primaryLocale: 'sv' },
  };
  const service = () =>
    new MailService(
      { get: () => undefined } as unknown as ConfigService,
      {
        platformConfig: { findFirst: jest.fn(() => Promise.resolve(null)) },
      } as unknown as PrismaService,
      {} as CryptoService,
      {} as NotificationTemplatesService,
      {} as StoreAppsService,
    );

  it.each([
    ['order_confirmation', true],
    ['new_order_owner', false],
    ['order_shipped', false],
    ['order_cancelled', false],
  ])('%s: note shown = %s', async (event, shown) => {
    const ctx = await service()['orderTemplateContext'](
      order as never,
      event as never,
    );
    expect(ctx.items_text.includes('Ta med glasögon')).toBe(shown);
    expect(ctx.items_html.includes('Ta med glasögon')).toBe(shown);
  });

  it('preview of a non-confirmation event renders through the confirmation context without notes', async () => {
    const ctx = await service()['orderTemplateContext'](
      order as never,
      'order_confirmation',
      'sv',
      false,
    );
    expect(ctx.items_text).not.toContain('Ta med glasögon');
  });
});

describe('MailService template preview sample note', () => {
  const sample = async (event: string) => {
    const prisma = {
      order: { findFirst: jest.fn(() => Promise.resolve(null)) },
      store: { findUnique: jest.fn(() => Promise.resolve(null)) },
      platformConfig: { findFirst: jest.fn(() => Promise.resolve(null)) },
    };
    const service = new MailService(
      { get: () => undefined } as unknown as ConfigService,
      prisma as unknown as PrismaService,
      {} as CryptoService,
      {} as NotificationTemplatesService,
      {} as StoreAppsService,
    );
    service['platformDisplayName'] = jest.fn(() =>
      Promise.resolve('ShopsDoor'),
    );
    return service['sampleTemplateVars'](event, 'sv', undefined);
  };

  it('order_confirmation preview shows a localized sample note', async () => {
    const vars = await sample('order_confirmation');
    expect(vars.items_text).toContain('Exempelanteckning');
  });

  it('other previews have no note', async () => {
    const vars = await sample('order_shipped');
    expect(vars.items_text).not.toContain('Exempelanteckning');
  });
});
