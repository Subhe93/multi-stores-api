import {
  cleanHtml,
  cleanTermName,
  cleanText,
  decodeHtmlEntities,
  htmlToPlainText,
  metaDescriptionFromExcerpt,
  resolveSeoTemplate,
  scanHtml,
  stripShortcodes,
  truncateWords,
} from './clean';

describe('text cleaning', () => {
  it('decodes entities', () => {
    expect(decodeHtmlEntities('Personliga &amp; unika')).toBe(
      'Personliga & unika',
    );
    expect(
      decodeHtmlEntities('&#8211; &#x2014; &auml;&ouml;&aring; &nbsp;'),
    ).toBe('– — äöå \u00a0');
    expect(decodeHtmlEntities('&unknown; &#0;')).toBe('&unknown; �');
  });

  it('removes U+200B, turns NBSP into a space, NFC and collapses whitespace', () => {
    expect(cleanText('Present till Fru\u200b')).toBe('Present till Fru');
    expect(cleanText('Blank\u00a0Silver')).toBe('Blank Silver');
    expect(cleanText('  Mellan   ')).toBe('Mellan');
    expect(cleanText('Ä')).toBe('Ä');
  });
});

describe('cleanTermName (D22)', () => {
  it.each([
    ['Liten (13–16 cm) - 350 kr', 'Liten (13–16 cm)', ['price_suffix']],
    ['Mellan (17–21 cm) - 550 kr', 'Mellan (17–21 cm)', ['price_suffix']],
    ['2 Inskriptioner (+50 kr)', '2 Inskriptioner', ['price_suffix']],
    [
      '4 Inskriptioner\u00a0(+120 kr)',
      '4 Inskriptioner',
      ['unicode', 'price_suffix'],
    ],
    ['1 produkt:', '1 produkt', ['trailing_colon']],
    ['Blank\u00a0Silver', 'Blank Silver', ['unicode']],
    [
      'Alla hjärtans dag present till pojkvän\u200b',
      'Alla hjärtans dag present till pojkvän',
      ['unicode'],
    ],
    ['Blå', 'Blå', []],
    ['olivgrön', 'olivgrön', []],
  ])('%j → %j', (raw, value, applied) => {
    const r = cleanTermName(raw);
    expect(r.value).toBe(value);
    expect(r.applied).toEqual(applied);
    expect(r.changed).toBe(raw !== value);
  });

  it('honours switched-off rules and never empties a name', () => {
    expect(
      cleanTermName('Liten - 350 kr', { strip_price_suffix: false }).value,
    ).toBe('Liten - 350 kr');
    expect(
      cleanTermName('1 produkt:', { strip_trailing_colon: false }).value,
    ).toBe('1 produkt:');
    expect(cleanTermName(':').value).toBe(':');
  });
});

describe('SEO strings', () => {
  it('resolves Rank Math variables and decodes entities', () => {
    expect(
      resolveSeoTemplate('%term% %sep% %sitename%', {
        term: 'Namnskyltar',
        sep: '-',
        sitename: 'namez',
      }),
    ).toBe('Namnskyltar - namez');
    expect(
      resolveSeoTemplate(
        'Present till pappa – Personliga &amp; unika presenter | namez',
        {},
      ),
    ).toBe('Present till pappa – Personliga & unika presenter | namez');
    expect(
      resolveSeoTemplate('%title% %page% %sep% %sitename%', {
        title: 'X',
        sep: '-',
        sitename: 'n',
      }),
    ).toBe('X - n');
    expect(resolveSeoTemplate(null, {})).toBe('');
  });

  it('builds a ≤160 meta description from an excerpt', () => {
    const html =
      '<p data-start="1" data-end="9">Beställ en <strong>stilren</strong> studentskylt&nbsp;med foto.</p>' +
      '<p>' +
      'ord '.repeat(80) +
      '</p>';
    const d = metaDescriptionFromExcerpt(html);
    expect(d.startsWith('Beställ en stilren studentskylt med foto. ord')).toBe(
      true,
    );
    expect(Array.from(d).length).toBeLessThanOrEqual(160);
    expect(d.endsWith(' ')).toBe(false);
    expect(truncateWords('kort', 160)).toBe('kort');
  });

  it('turns HTML into plain text without shortcodes', () => {
    expect(
      htmlToPlainText(
        '<h2>Rubrik</h2><p>Text&amp;mer</p>[namez_card]<script>x()</script>',
      ),
    ).toBe('Rubrik Text&mer');
  });
});

describe('HTML scanning and shortcodes', () => {
  const sample = [
    '<p data-start="0" data-end="12" data-message-author-role="assistant">Hej</p>',
    '[video width="1280" height="720" mp4="https://namez.se/wp-content/uploads/2024/09/25wide-video.mp4"][/video]',
    '<div style="width: calc(100% - 2px)">[data-x] stays</div>',
    '[namez_card]',
    '<img src="https://assets.lightfunnels.com/a.gif" alt="x" />',
    '<a href="javascript:alert(1)" onclick="x()">l</a><iframe src="https://e.x"></iframe>',
    '[caption id="c1"]<img src="https://namez.se/wp-content/uploads/b.jpg">Bild[/caption]',
  ].join('\n');

  it('extracts videos, removes known shortcodes and leaves other brackets alone', () => {
    const r = stripShortcodes(sample);
    expect(r.videos).toEqual([
      'https://namez.se/wp-content/uploads/2024/09/25wide-video.mp4',
    ]);
    expect(r.removed).toEqual({ video: 1, namez_card: 1, caption: 1 });
    expect(r.html).toContain('[data-x] stays');
    expect(r.html).toContain('calc(100% - 2px)');
    expect(r.html).not.toContain('[namez_card]');
    expect(r.html).toContain('>Bild');
  });

  it('reports what the sanitizer will remove', () => {
    const s = scanHtml(sample);
    expect(s.data_attributes).toBe(3);
    expect(s.unsafe_elements).toBe(1);
    expect(s.event_handlers).toBe(1);
    expect(s.javascript_urls).toBe(1);
    expect(s.inline_images).toEqual([
      'https://assets.lightfunnels.com/a.gif',
      'https://namez.se/wp-content/uploads/b.jpg',
    ]);
  });

  it('requires a sanitizer and applies it after shortcode handling', () => {
    const calls: string[] = [];
    const r = cleanHtml('<p>a</p>[namez_card]', {
      sanitize: (h) => {
        calls.push(h);
        return h.replace(/<[^>]+>/g, '');
      },
    });
    expect(calls).toEqual(['<p>a</p>']);
    expect(r.html).toBe('a');
    expect(r.removed_shortcodes.namez_card).toBe(1);
  });
});
