import { Test } from '@nestjs/testing';
import {
  htmlToSafeParagraphs,
  IMPORTER_HTML_SANITIZER,
  importerHtmlSanitizerProvider,
  PlainTextHtmlSanitizer,
  type ImporterHtmlSanitizer,
} from './html-sanitizer';

describe('PlainTextHtmlSanitizer (fallback until sanitize-html is approved)', () => {
  const s = new PlainTextHtmlSanitizer();

  it('is the bound implementation and reports fallback mode', async () => {
    const mod = await Test.createTestingModule({
      providers: [importerHtmlSanitizerProvider],
    }).compile();
    const bound = mod.get<ImporterHtmlSanitizer>(IMPORTER_HTML_SANITIZER);
    expect(bound).toBeInstanceOf(PlainTextHtmlSanitizer);
    expect(bound.mode).toBe('plain_text_fallback');
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
