/**
 * The platform company (ShopsDoor is operated by Namez AB). Single source of
 * the company facts used by the platform legal texts (prisma/legal/shopsdoor-en.ts)
 * and by MARKETPLACE store legal pages, where Namez AB is the seller of record.
 */
export const PLATFORM_BRAND = 'ShopsDoor';
export const PLATFORM_COMPANY = 'Namez AB';
export const PLATFORM_ORG_NUMBER = '559295-1007';
/** Platform contact email when PlatformConfig.support_email is not set. */
export const PLATFORM_CONTACT_EMAIL = 'hello@shopsdoor.com';

/** Registered address, structured like trader_details (country = ISO2). */
export const PLATFORM_ADDRESS = Object.freeze({
  address_line1: 'Hagavägen 36',
  postal_code: '784 40',
  city: 'Borlänge',
  country: 'SE',
});

/** One-line English address: "Hagavägen 36, 784 40 Borlänge, Sweden". */
export const PLATFORM_ADDRESS_EN = `${PLATFORM_ADDRESS.address_line1}, ${PLATFORM_ADDRESS.postal_code} ${PLATFORM_ADDRESS.city}, Sweden`;
