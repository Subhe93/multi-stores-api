import { sanitizeCreatorHtml } from './creator-html';

// Creator HTML is rendered on the storefront with dangerouslySetInnerHTML,
// so everything that can run script must be gone after the write-time
// sanitizer, while Tiptap formatting survives untouched.

describe('sanitizeCreatorHtml', () => {
  it('null / undefined / whitespace give null', () => {
    expect(sanitizeCreatorHtml(null)).toBeNull();
    expect(sanitizeCreatorHtml(undefined)).toBeNull();
    expect(sanitizeCreatorHtml('')).toBeNull();
    expect(sanitizeCreatorHtml('   \n ')).toBeNull();
  });

  it('input that is empty after sanitizing gives null', () => {
    expect(sanitizeCreatorHtml('<script>alert(1)</script>')).toBeNull();
  });

  it('plain text and simple formatting are unchanged', () => {
    expect(sanitizeCreatorHtml('Hello world')).toBe('Hello world');
    expect(sanitizeCreatorHtml('<p>Hi <strong>there</strong></p>')).toBe(
      '<p>Hi <strong>there</strong></p>',
    );
  });

  it('drops <script> with its content', () => {
    expect(
      sanitizeCreatorHtml('<p>a</p><script>alert(1)</script><p>b</p>'),
    ).toBe('<p>a</p><p>b</p>');
  });

  it('drops <style> tags, forms and embeds', () => {
    expect(
      sanitizeCreatorHtml(
        '<style>body{display:none}</style><form><input name="x"></form><object data="x"></object><embed src="x"><p>ok</p>',
      ),
    ).toBe('<p>ok</p>');
  });

  it('drops on* handlers', () => {
    expect(sanitizeCreatorHtml('<img src="/a.png" onerror="alert(1)">')).toBe(
      '<img src="/a.png" />',
    );
    expect(sanitizeCreatorHtml('<p onclick="x()">t</p>')).toBe('<p>t</p>');
  });

  it('drops javascript: and data: URLs', () => {
    expect(sanitizeCreatorHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a>x</a>',
    );
    expect(sanitizeCreatorHtml('<a href="JaVaScRiPt&#58;alert(1)">x</a>')).toBe(
      '<a>x</a>',
    );
    expect(
      sanitizeCreatorHtml('<img src="data:image/png;base64,AAAA">'),
    ).toBeNull();
  });

  it('keeps http(s), mailto and tel links and relative URLs', () => {
    expect(sanitizeCreatorHtml('<a href="https://x.se/p">x</a>')).toBe(
      '<a href="https://x.se/p">x</a>',
    );
    expect(sanitizeCreatorHtml('<a href="mailto:a@b.se">m</a>')).toBe(
      '<a href="mailto:a@b.se">m</a>',
    );
    expect(sanitizeCreatorHtml('<a href="tel:+4670">t</a>')).toBe(
      '<a href="tel:+4670">t</a>',
    );
    expect(sanitizeCreatorHtml('<img src="/uploads/a.jpg" alt="A">')).toBe(
      '<img src="/uploads/a.jpg" alt="A" />',
    );
  });

  it('target=_blank links get rel="noopener noreferrer"', () => {
    expect(
      sanitizeCreatorHtml('<a href="https://x.se" target="_blank">x</a>'),
    ).toBe(
      '<a href="https://x.se" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(
      sanitizeCreatorHtml(
        '<a href="https://x.se" target="_blank" rel="nofollow">x</a>',
      ),
    ).toBe(
      '<a href="https://x.se" target="_blank" rel="nofollow noopener noreferrer">x</a>',
    );
    // Other targets are dropped; a plain link keeps no rel.
    expect(sanitizeCreatorHtml('<a href="/p" target="_top">x</a>')).toBe(
      '<a href="/p">x</a>',
    );
  });

  it('keeps YouTube / Vimeo https iframes and drops every other iframe', () => {
    expect(
      sanitizeCreatorHtml(
        '<iframe src="https://www.youtube.com/embed/abc" width="560" height="315"></iframe>',
      ),
    ).toBe(
      '<iframe src="https://www.youtube.com/embed/abc" width="560" height="315"></iframe>',
    );
    expect(
      sanitizeCreatorHtml(
        '<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>',
      ),
    ).toBe(
      '<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>',
    );
    expect(
      sanitizeCreatorHtml(
        '<iframe src="https://player.vimeo.com/video/1"></iframe>',
      ),
    ).toBe('<iframe src="https://player.vimeo.com/video/1"></iframe>');
    expect(
      sanitizeCreatorHtml(
        '<p>a</p><iframe src="https://evil.example/x"></iframe>',
      ),
    ).toBe('<p>a</p>');
    expect(
      sanitizeCreatorHtml(
        '<iframe src="http://www.youtube.com/embed/abc"></iframe>',
      ),
    ).toBeNull();
    expect(
      sanitizeCreatorHtml(
        '<iframe src="https://youtube.com.evil.example/e"></iframe>',
      ),
    ).toBeNull();
    expect(sanitizeCreatorHtml('<iframe src="/local"></iframe>')).toBeNull();
    expect(
      sanitizeCreatorHtml('<iframe srcdoc="<script>x</script>"></iframe>'),
    ).toBeNull();
  });

  it('keeps only allowlisted style declarations', () => {
    expect(
      sanitizeCreatorHtml(
        '<p style="text-align: center; color: #ff0000; position: fixed; background: url(x)">t</p>',
      ),
    ).toBe('<p style="text-align:center;color:#ff0000">t</p>');
    expect(
      sanitizeCreatorHtml(
        '<span style="font-weight: bold; background-color: rgb(1, 2, 3); behavior: url(x)">t</span>',
      ),
    ).toBe(
      '<span style="font-weight:bold;background-color:rgb(1, 2, 3)">t</span>',
    );
    expect(
      sanitizeCreatorHtml('<p style="color: expression(alert(1))">t</p>'),
    ).toBe('<p>t</p>');
  });

  it('preserves nested lists and tables', () => {
    const list = '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>';
    expect(sanitizeCreatorHtml(list)).toBe(list);
    const table =
      '<table><thead><tr><th colspan="2">H</th></tr></thead><tbody><tr><td>1</td><td rowspan="2">2</td></tr></tbody></table>';
    expect(sanitizeCreatorHtml(table)).toBe(table);
  });

  it('keeps the Tiptap block set (headings, quote, code, figure, video, mark)', () => {
    const html =
      '<h2>T</h2><blockquote><p>q</p></blockquote><pre><code>x &lt; y</code></pre>' +
      '<figure><img src="/a.png" width="100" height="50" loading="lazy" /><figcaption>c</figcaption></figure>' +
      '<p><mark>m</mark> <sub>s</sub><sup>p</sup> <s>d</s> <u>u</u></p><hr />' +
      '<video controls poster="/p.jpg"><source src="/v.mp4" /></video>';
    expect(sanitizeCreatorHtml(html)).toBe(html);
  });

  it('keeps class attributes and drops unknown ones', () => {
    expect(
      sanitizeCreatorHtml('<div class="x" data-foo="1" id="y">t</div>'),
    ).toBe('<div class="x">t</div>');
  });
});
