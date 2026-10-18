import { Test } from '@nestjs/testing';
import {
  AllowlistHtmlSanitizer,
  createImporterHtmlSanitizer,
  htmlToSafeParagraphs,
  IMPORTER_HTML_SANITIZER,
  IMPORTER_HTML_SANITIZER_ENV,
  importerHtmlSanitizerProvider,
  PlainTextHtmlSanitizer,
  unnestAnchors,
  type ImporterHtmlSanitizer,
} from './html-sanitizer';

describe('sanitizer binding', () => {
  it('binds the allowlist sanitizer by default and the fallback with IMPORTER_HTML_SANITIZER=plain', async () => {
    const prev = process.env[IMPORTER_HTML_SANITIZER_ENV];
    delete process.env[IMPORTER_HTML_SANITIZER_ENV];
    try {
      const mod = await Test.createTestingModule({
        providers: [importerHtmlSanitizerProvider],
      }).compile();
      const bound = mod.get<ImporterHtmlSanitizer>(IMPORTER_HTML_SANITIZER);
      expect(bound).toBeInstanceOf(AllowlistHtmlSanitizer);
      expect(bound.mode).toBe('allowlist');
    } finally {
      if (prev !== undefined) process.env[IMPORTER_HTML_SANITIZER_ENV] = prev;
    }
    expect(
      createImporterHtmlSanitizer({ IMPORTER_HTML_SANITIZER: 'plain' }),
    ).toBeInstanceOf(PlainTextHtmlSanitizer);
    expect(
      createImporterHtmlSanitizer({ IMPORTER_HTML_SANITIZER: ' Plain ' }).mode,
    ).toBe('plain_text_fallback');
    expect(
      createImporterHtmlSanitizer({ IMPORTER_HTML_SANITIZER: 'allowlist' })
        .mode,
    ).toBe('allowlist');
    expect(createImporterHtmlSanitizer({}).mode).toBe('allowlist');
  });
});

describe('AllowlistHtmlSanitizer (sanitize-html, D11)', () => {
  const s = new AllowlistHtmlSanitizer();
  const namez = { source_host: 'namez.se' };

  it('keeps the allowlisted structure of a product description', () => {
    const html =
      '<h2>Om produkten</h2><p>Hej <strong>du</strong>, <em>fin</em> <b>text</b></p>' +
      '<ul><li>En</li><li>Två</li></ul><ol><li>1</li></ol>' +
      '<blockquote>Citat</blockquote><h3>H3</h3><h4>H4</h4><hr>' +
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>' +
      '<div><span>inline</span></div><p>a<br>b</p>';
    expect(s.sanitize(html)).toBe(
      '<h2>Om produkten</h2><p>Hej <strong>du</strong>, <em>fin</em> <b>text</b></p>' +
        '<ul><li>En</li><li>Två</li></ul><ol><li>1</li></ol>' +
        '<blockquote>Citat</blockquote><h3>H3</h3><h4>H4</h4><hr />' +
        '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>' +
        '<div><span>inline</span></div><p>a<br />b</p>',
    );
  });

  it('drops attributes that are not allowlisted: class, id, style, data-*, on*', () => {
    expect(
      s.sanitize(
        '<p data-start="1" class="x" id="y" style="color:red;width:expression(alert(1))" onclick="alert(1)">Hej</p>' +
          '<span style="background:url(javascript:alert(1))">s</span>' +
          '<ul data-x="1"><li onmouseover="x()">i</li></ul>',
      ),
    ).toBe('<p>Hej</p><span>s</span><ul><li>i</li></ul>');
  });

  it('removes unknown elements but keeps their text; h1/h5/h6/pre/form become text', () => {
    expect(
      s.sanitize(
        '<h1>Titel</h1><pre>code</pre><form><input value="x"><button>Go</button></form><section>sec</section>',
      ),
    ).toBe('Titelcodesec');
  });

  it('XSS: script, style, iframe, object, embed, svg, math and their content are gone', () => {
    const out = s.sanitize(
      '<p>ok</p><script>alert(1)</script><style>p{}</style><iframe src="//evil">fb</iframe>' +
        '<object data="x">o</object><embed src="x"><svg onload="alert(1)"><text>t</text><script>1</script></svg>' +
        '<math><mi>m</mi></math><noscript>n</noscript><template>t</template><!-- c -->',
    );
    expect(out).toBe('<p>ok</p>');
  });

  it('XSS: mutation vectors (solidus close, SMIL, unclosed non-text tags) leave no markup behind', () => {
    // GHSA-jxwj-j7wr-gfrw: `</textarea/>` must close the element, not leak the payload.
    const mx = s.sanitize(
      '<textarea><p></textarea/><img src=x onerror=alert(1)></textarea><p>after</p>',
    );
    expect(mx).not.toMatch(/onerror|<textarea/i);
    // The `<img>` after the real close is ordinary content: handler gone, relative src kept.
    expect(mx).toBe('<img src="x" /><p>after</p>');
    // GHSA-g8qq-57p8-ggw5: SVG SMIL with a javascript: URI list.
    expect(
      s.sanitize(
        '<svg><a><animate attributeName="href" values="javascript:alert(1)" /><text>t</text></a></svg><p>x</p>',
      ),
    ).toBe('<p>x</p>');
    // An unclosed script swallows the rest instead of leaking it.
    expect(s.sanitize('<p>a</p><script>alert(1)<p>b</p>')).toBe('<p>a</p>');
    // Comments cannot smuggle markup, conditional or not.
    expect(
      s.sanitize('<!--[if IE]><script>1</script><![endif]--><p>c</p>'),
    ).toBe('<p>c</p>');
  });

  it('XSS: javascript:/data:/vbscript: and encoded or tab-split schemes never survive in href', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      ' javascript:alert(1)',
      '&#106;avascript:alert(1)',
      '&#x6A;avascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox',
      'jav&#x0A;ascript:alert(1)',
    ]) {
      const out = s.sanitize(`<a href="${href}">l</a>`);
      expect(out).not.toMatch(/javascript|vbscript|data:/i);
      expect(out).toMatch(/^<a(?: rel="[a-z ]+")?>l<\/a>$/);
    }
  });

  it('XSS: img onerror, data: and javascript: src → the image is removed', () => {
    // A relative src is on the source host: kept, the handler is not.
    expect(s.sanitize('<p>x<img src=x onerror=alert(1)>y</p>')).toBe(
      '<p>x<img src="x" />y</p>',
    );
    expect(s.sanitize('<p>x<img onerror=alert(1)>y</p>')).toBe('<p>xy</p>');
    expect(s.sanitize('<img src="data:image/png;base64,AA">')).toBe('');
    expect(s.sanitize('<img src="javascript:alert(1)">')).toBe('');
    expect(s.sanitize('<img src="ftp://namez.se/a.png">')).toBe('');
    expect(
      s.sanitizeDetailed(
        '<img src="data:,x"><img src="https://namez.se/a.png" onerror="x()">',
      ).images_removed,
    ).toBe(1);
  });

  it('XSS: nested anchors never survive, protocol-relative links become https', () => {
    // The safety net on its own (older htmlparser2 kept `<a>` inside `<a>`).
    expect(
      unnestAnchors('<a href="http://a">x<a href="http://b">y</a>z</a>'),
    ).toBe('<a href="http://a">xyz</a>');
    expect(unnestAnchors('</a>loose<a href="x">a</a>')).toBe(
      'loose<a href="x">a</a>',
    );
    // htmlparser2 12 closes the outer anchor like a browser: siblings, each sanitized.
    expect(
      s.sanitize(
        '<a href="https://namez.se/p">x<a href="https://evil.example/">y</a>z</a>',
        namez,
      ),
    ).toBe(
      '<a href="https://namez.se/p">x</a><a href="https://evil.example/" rel="nofollow noopener">y</a>z',
    );
    expect(s.sanitize('<a href="//evil.example/p">x</a>', namez)).toBe(
      '<a href="https://evil.example/p" rel="nofollow noopener">x</a>',
    );
  });

  it('links: external ones get rel="noopener nofollow", internal/relative ones do not; target only _blank', () => {
    expect(
      s.sanitize('<a href="https://namez.se/produkt/x" title="t">x</a>', namez),
    ).toBe('<a href="https://namez.se/produkt/x" title="t">x</a>');
    expect(s.sanitize('<a href="/produkt/x">x</a>', namez)).toBe(
      '<a href="/produkt/x">x</a>',
    );
    expect(
      s.sanitize(
        '<a href="https://www.instagram.com/namez" rel="me">x</a>',
        namez,
      ),
    ).toBe(
      '<a href="https://www.instagram.com/namez" rel="nofollow noopener">x</a>',
    );
    expect(s.sanitize('<a href="/x" target="_blank">x</a>', namez)).toBe(
      '<a href="/x" target="_blank" rel="noopener">x</a>',
    );
    expect(s.sanitize('<a href="/x" target="_parent">x</a>', namez)).toBe(
      '<a href="/x">x</a>',
    );
    // Without a source host every absolute link is external.
    expect(s.sanitize('<a href="https://namez.se/x">x</a>')).toBe(
      '<a href="https://namez.se/x" rel="nofollow noopener">x</a>',
    );
    expect(s.sanitize('<a href="mailto:a@b.se">m</a>')).toBe('<a>m</a>');
  });

  it('images: source host and inline_image_hosts kept (width/height numeric only), other hosts removed', () => {
    const ctx = { source_host: 'namez.se', image_hosts: ['cdn.example.com'] };
    expect(
      s.sanitize(
        '<img src="https://namez.se/wp-content/a.jpg" alt="A" width="300" height="auto" class="x" loading="lazy">',
        ctx,
      ),
    ).toBe(
      '<img src="https://namez.se/wp-content/a.jpg" alt="A" width="300" />',
    );
    expect(
      s.sanitize('<img src="/wp-content/uploads/b.jpg" alt="">', ctx),
    ).toBe('<img src="/wp-content/uploads/b.jpg" alt="" />');
    expect(s.sanitize('<img src="//namez.se/c.jpg">', ctx)).toBe(
      '<img src="https://namez.se/c.jpg" />',
    );
    expect(s.sanitize('<img src="https://CDN.example.com/d.png">', ctx)).toBe(
      '<img src="https://cdn.example.com/d.png" />',
    );
    const r = s.sanitizeDetailed(
      '<p>t</p><img src="https://evil.example/e.png"><img src="http://other.se/f.png">',
      ctx,
    );
    expect(r.html).toBe('<p>t</p>');
    expect(r.images_removed).toBe(2);
    expect(r.changed).toBe(true);
    // Without a context the host filter is the caller's job: http(s) images stay.
    expect(s.sanitize('<img src="https://anything.example/g.png">')).toBe(
      '<img src="https://anything.example/g.png" />',
    );
  });

  it('text is entity-escaped, so encoded markup cannot become a tag', () => {
    expect(
      s.sanitize(
        '&lt;script&gt;alert(1)&lt;/script&gt; &amp; S&ouml;t < 3 "q"',
      ),
    ).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Söt &lt; 3 "q"');
    expect(s.sanitize('<p title="a > b">x</p> 1 < 2')).toBe(
      '<p>x</p> 1 &lt; 2',
    );
    expect(s.sanitize('ok <img src="x" ')).toBe('ok');
  });

  it('wpautop: bare text with newlines becomes paragraphs; content with blocks is untouched', () => {
    expect(s.sanitize('Rad ett\nrad två\n\nNytt stycke')).toBe(
      '<p>Rad ett<br />rad två</p><p>Nytt stycke</p>',
    );
    expect(s.sanitize('<strong>Fet</strong> text\r\n\r\nMer')).toBe(
      '<p><strong>Fet</strong> text</p><p>Mer</p>',
    );
    expect(s.sanitize('<p>a</p>\n<p>b</p>')).toBe('<p>a</p>\n<p>b</p>');
    expect(s.sanitize('<ul><li>a</li>\n<li>b</li></ul>')).toBe(
      '<ul><li>a</li>\n<li>b</li></ul>',
    );
    expect(s.sanitize('one line')).toBe('one line');
    expect(s.sanitizeDetailed('Rad ett\n\nTvå').changed).toBe(false);
  });

  it('is idempotent and reports "changed" only when something was removed', () => {
    const clean =
      '<h2>T</h2><p>a<br />b <strong>c</strong></p><ul><li>x</li></ul>';
    expect(s.sanitize(clean)).toBe(clean);
    expect(s.sanitize(s.sanitize('<p>a<br>b</p><h2 class="x">t</h2>'))).toBe(
      s.sanitize('<p>a<br>b</p><h2 class="x">t</h2>'),
    );
    expect(s.sanitizeDetailed(clean).changed).toBe(false);
    expect(s.sanitizeDetailed('<p>a<br>b</p>').changed).toBe(false);
    expect(s.sanitizeDetailed('<p data-start="1">a</p>').changed).toBe(true);
    expect(s.sanitizeDetailed('<p>a</p><script>1</script>').changed).toBe(true);
    expect(s.sanitize('')).toBe('');
    expect(s.sanitize(null as unknown as string)).toBe('');
  });
});

describe('PlainTextHtmlSanitizer (fallback, IMPORTER_HTML_SANITIZER=plain)', () => {
  const s = new PlainTextHtmlSanitizer();

  it('reports fallback mode', () => {
    expect(s.mode).toBe('plain_text_fallback');
    expect(s.sanitizeDetailed('<p>a</p><img src="x">')).toEqual({
      html: '<p>a</p>',
      changed: true,
      images_removed: 1,
    });
  });

  it('keeps no source markup: only its own <p> and <br>', () => {
    const out = s.sanitize(
      '<p data-start="1" class="x" onclick="alert(1)">Hej <strong>du</strong></p><a href="javascript:alert(1)">länk</a><img src=x onerror=alert(1)>',
    );
    expect(out).toBe('<p>Hej du</p><p>länk</p>');
    expect(out.replace(/<\/?p>|<br>/g, '')).not.toMatch(/[<>]/);
  });

  it('drops script/style/iframe content and comments', () => {
    const out = s.sanitize(
      '<script>alert("x")</script><style>p{}</style><!-- c --><iframe src="//x">fallback</iframe>Text',
    );
    expect(out).toBe('<p>Text</p>');
  });

  it('decodes entities then escapes them, so encoded markup cannot become a tag', () => {
    expect(
      s.sanitize('&lt;script&gt;alert(1)&lt;/script&gt; &amp; S&ouml;t'),
    ).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; Söt</p>');
  });

  it('turns blocks into paragraphs, <br> and newlines into line breaks (wpautop)', () => {
    expect(s.sanitize('Rad ett\nrad två\n\nNytt stycke')).toBe(
      '<p>Rad ett<br>rad två</p><p>Nytt stycke</p>',
    );
    expect(s.sanitize('<h2>Rubrik</h2><ul><li>A</li><li>B</li></ul>')).toBe(
      '<p>Rubrik</p><p>• A<br>• B</p>',
    );
    expect(s.sanitize('a<br/>b')).toBe('<p>a<br>b</p>');
  });

  it('handles quotes with ">" inside attributes, lone "<" and unterminated tags', () => {
    expect(s.sanitize('<a title="a > b">x</a> 1 < 2')).toBe(
      '<p>x 1 &lt; 2</p>',
    );
    expect(s.sanitize('ok <img src="x" ')).toBe('<p>ok</p>');
  });

  it('empty input → empty string', () => {
    expect(htmlToSafeParagraphs('')).toBe('');
    expect(htmlToSafeParagraphs(null)).toBe('');
    expect(htmlToSafeParagraphs('<p>  </p>')).toBe('');
  });
});
