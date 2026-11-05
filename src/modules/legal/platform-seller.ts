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

/**
 * The platform company in the `Store.trader_details` shape, so the storefront
 * renders it wherever it shows the seller of record (MARKETPLACE stores).
 * `email` is PlatformConfig.support_email or PLATFORM_CONTACT_EMAIL.
 */
export function platformSellerDetails(email?: string | null) {
  return {
    legal_name: PLATFORM_COMPANY,
    business_type: 'company' as const,
    org_number: PLATFORM_ORG_NUMBER,
    vat_number: '',
    ...PLATFORM_ADDRESS,
    address_line2: '',
    phone: '',
    support_email: (email ?? '').trim() || PLATFORM_CONTACT_EMAIL,
    /** Marks the platform as seller so the storefront can say "Sold by". */
    is_platform: true as const,
    platform_brand: PLATFORM_BRAND,
  };
}

export type PlatformSellerDetails = ReturnType<typeof platformSellerDetails>;

/**
 * The seller of record a storefront shows: the platform for MARKETPLACE
 * stores, the store's own trader details otherwise (null when not set).
 */
export function storeSellerDetails(
  store: { store_type: string; trader_details: unknown },
  platformEmail?: string | null,
): PlatformSellerDetails | Record<string, unknown> | null {
  if (store.store_type === 'MARKETPLACE') {
    return platformSellerDetails(platformEmail);
  }
  const t = store.trader_details;
  return t && typeof t === 'object' && !Array.isArray(t)
    ? (t as Record<string, unknown>)
    : null;
}
