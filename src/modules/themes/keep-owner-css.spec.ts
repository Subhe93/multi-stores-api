import { keepOwnerCss } from './keep-owner-css';

describe('keepOwnerCss', () => {
  it('carries a non-empty customCss over', () => {
    expect(
      keepOwnerCss({ colors: { primary: '#000' }, customCss: 'a{color:red}' }),
    ).toEqual({
      customCss: 'a{color:red}',
    });
  });

  it('gives nothing for missing, blank or non-string values and non-objects', () => {
    for (const prev of [
      null,
      undefined,
      'x',
      [],
      {},
      { customCss: '' },
      { customCss: '  ' },
      { customCss: 12 },
    ]) {
      expect(keepOwnerCss(prev)).toEqual({});
    }
  });
});
