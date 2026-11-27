import { careOfLine } from '../../common/address/care-of';
import { renderShippingAddress } from './order-mail.helpers';

// M175: the delivery block of every order email names the RECIPIENT of the
// parcel (Address.full_name), then "c/o <care_of>" on its own line when the
// address has one, then the street. The greeting and the "customer" line
// come from the customer profile (MailService: customer_name /
// customer_first_name) and are not part of this block.

const address = {
  full_name: 'Karin Berg',
  line1: 'Sturegatan 6',
  line2: null,
  city: 'Stockholm',
  state: null,
  postal_code: '114 35',
  country_code: 'SE',
  phone: '+46700000000',
};

describe('renderShippingAddress (M175 recipient + c/o)', () => {
  it('recipient first, then the c/o line, then the street', () => {
    const block = renderShippingAddress(
      { ...address, care_of: 'Familjen Lind' },
      'en',
    );
    expect(block.text.split('\n')).toEqual([
      'Karin Berg',
      'c/o Familjen Lind',
      'Sturegatan 6',
      '114 35 Stockholm',
      'Sweden',
      '+46700000000',
    ]);
    expect(block.html).toBe(
      'Karin Berg<br />c/o Familjen Lind<br />Sturegatan 6<br />114 35 Stockholm<br />Sweden<br />+46700000000',
    );
  });

  it('no c/o line when the address has none (the block built before)', () => {
    const lines = ['Karin Berg', 'Sturegatan 6', '114 35 Stockholm', 'Sweden'];
    for (const care_of of [undefined, null, '', '   ']) {
      const block = renderShippingAddress(
        { ...address, phone: null, care_of },
        'en',
      );
      expect(block.text.split('\n')).toEqual(lines);
    }
    const legacy = renderShippingAddress({ ...address, phone: null }, 'en');
    expect(legacy.text.split('\n')).toEqual(lines);
  });

  it('escapes the c/o value in the HTML block', () => {
    const block = renderShippingAddress(
      { ...address, care_of: '<b>Lind</b> & co' },
      'en',
    );
    expect(block.html).toContain('c/o &lt;b&gt;Lind&lt;/b&gt; &amp; co');
    expect(block.text).toContain('c/o <b>Lind</b> & co');
  });

  it('no address: empty block', () => {
    expect(renderShippingAddress(null, 'en')).toEqual({ html: '', text: '' });
  });
});

describe('careOfLine', () => {
  it('prefixes the value once', () => {
    expect(careOfLine('Familjen Lind')).toBe('c/o Familjen Lind');
    expect(careOfLine('  Familjen Lind ')).toBe('c/o Familjen Lind');
    expect(careOfLine('c/o Familjen Lind')).toBe('c/o Familjen Lind');
    expect(careOfLine('C/O: Familjen Lind')).toBe('c/o Familjen Lind');
    expect(careOfLine('c / o Familjen Lind')).toBe('c/o Familjen Lind');
  });

  it('keeps a name that only starts with the same letters', () => {
    expect(careOfLine('Cornelia')).toBe('c/o Cornelia');
  });

  it('empty for nothing to print', () => {
    expect(careOfLine(null)).toBe('');
    expect(careOfLine(undefined)).toBe('');
    expect(careOfLine('   ')).toBe('');
    expect(careOfLine('c/o')).toBe('');
  });
});
