import { createHash } from 'crypto';
import { canAccessDesign, designAccessGrant } from './designer-access';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

describe('designAccessGrant (guest token after claim)', () => {
  const guest = { customer_id: null, access_token_hash: hash('tok') };
  const claimed = { customer_id: 'c1', access_token_hash: hash('tok') };

  it('a guest design is reachable with its token only', () => {
    expect(designAccessGrant(guest, { customerId: null, token: 'tok' })).toBe(
      'token',
    );
    expect(designAccessGrant(guest, { customerId: 'c9', token: 'bad' })).toBe(
      null,
    );
    expect(designAccessGrant(guest, { customerId: null, token: null })).toBe(
      null,
    );
  });

  it('a claimed design ignores the token: JWT of its customer only', () => {
    expect(designAccessGrant(claimed, { customerId: 'c1', token: null })).toBe(
      'customer',
    );
    expect(canAccessDesign(claimed, { customerId: null, token: 'tok' })).toBe(
      false,
    );
    // Another account holding the old guest token cannot take it over.
    expect(canAccessDesign(claimed, { customerId: 'c2', token: 'tok' })).toBe(
      false,
    );
  });

  it('rejects oversized tokens without hashing them', () => {
    expect(
      canAccessDesign(guest, { customerId: null, token: 'x'.repeat(257) }),
    ).toBe(false);
  });
});
