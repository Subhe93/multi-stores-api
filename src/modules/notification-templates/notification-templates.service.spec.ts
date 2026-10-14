import { htmlVars, substitute } from './notification-templates.service';

// An `html:<name>` variable overrides `<name>` for the HTML body only, so a
// caller can hand over an escaped copy of a shopper-typed value without
// changing how any other variable (or the text / subject) renders.
describe('htmlVars', () => {
  const vars = {
    company_name: 'Bob & <Sons>',
    'html:company_name': 'Bob &amp; &lt;Sons&gt;',
    customer_name: 'Anna',
  };

  it('applies the html override to the HTML body only', () => {
    const tpl = '{{company_name}} / {{customer_name}}';
    expect(substitute(tpl, htmlVars(vars))).toBe(
      'Bob &amp; &lt;Sons&gt; / Anna',
    );
    expect(substitute(tpl, vars)).toBe('Bob & <Sons> / Anna');
  });

  it('is a no-op without overrides and keeps conditions working', () => {
    expect(htmlVars({ a: '1' })).toEqual({ a: '1' });
    expect(substitute('{{#if company_name}}x{{/if}}', htmlVars(vars))).toBe(
      'x',
    );
  });
});
