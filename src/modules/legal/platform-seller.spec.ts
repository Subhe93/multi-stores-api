import {
  PLATFORM_CONTACT_EMAIL,
  platformSellerDetails,
  storeSellerDetails,
} from './platform-seller';

describe('platform seller details', () => {
  it('shapes Namez AB like trader_details', () => {
    expect(platformSellerDetails('support@shopsdoor.com')).toMatchObject({
      legal_name: 'Namez AB',
      org_number: '559295-1007',
      address_line1: 'Hagavägen 36',
      postal_code: '784 40',
      city: 'Borlänge',
      country: 'SE',
      support_email: 'support@shopsdoor.com',
      is_platform: true,
    });
  });

  it('falls back to the platform contact email', () => {
    expect(platformSellerDetails(null).support_email).toBe(PLATFORM_CONTACT_EMAIL);
    expect(platformSellerDetails('  ').support_email).toBe(PLATFORM_CONTACT_EMAIL);
  });

  it('MARKETPLACE stores sell as the platform, not the influencer', () => {
    const seller = storeSellerDetails(
      {
        store_type: 'MARKETPLACE',
        trader_details: { legal_name: 'E2E Influencer AB', org_number: '5599123469' },
      },
      'ops@shopsdoor.com',
    );
    expect(seller).toMatchObject({ legal_name: 'Namez AB', support_email: 'ops@shopsdoor.com' });
  });

  it('INDEPENDENT stores keep their own trader details', () => {
    const t = { legal_name: 'Own AB', org_number: '5560160680' };
    expect(storeSellerDetails({ store_type: 'INDEPENDENT', trader_details: t })).toBe(t);
    expect(storeSellerDetails({ store_type: 'INDEPENDENT', trader_details: null })).toBeNull();
  });
});
