import {
  hostnameOf,
  isPlatformHost,
  platformHosts,
  platformSubdomainOf,
} from './platform-hosts';
import { isReservedDomainFor } from './reserved-hosts';

// Domain-move overlap: the old and the new apex are both platform hosts.
const BOTH = {
  STOREFRONT_URL: 'https://shopsdoor.com',
  PLATFORM_HOSTS:
    'shopsdoor.com, www.shopsdoor.com,iwings-digital.com,www.iwings-digital.com',
};

describe('platform-hosts', () => {
  it('hostnameOf: URL or bare host, lower-case, no port', () => {
    expect(hostnameOf('https://API.ShopsDoor.com:8443/x')).toBe(
      'api.shopsdoor.com',
    );
    expect(hostnameOf(' shopsdoor.com ')).toBe('shopsdoor.com');
    expect(hostnameOf('localhost:3003')).toBe('localhost');
    expect(hostnameOf('')).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
  });

  it('platformHosts: STOREFRONT_URL host first (bare + www), the list, then localhost', () => {
    expect(platformHosts(BOTH)).toEqual([
      'shopsdoor.com',
      'www.shopsdoor.com',
      'iwings-digital.com',
      'www.iwings-digital.com',
      'localhost',
    ]);
    expect(platformHosts({ STOREFRONT_URL: 'https://www.shopsdoor.com' })).toEqual([
      'www.shopsdoor.com',
      'shopsdoor.com',
      'localhost',
    ]);
    expect(platformHosts({ STOREFRONT_URL: 'http://localhost:3003' })).toEqual([
      'localhost',
    ]);
    expect(platformHosts({})).toEqual(['localhost']);
    // Legacy env name still read.
    expect(
      platformHosts({ NEXT_PUBLIC_PLATFORM_HOSTS: 'iwings-digital.com' }),
    ).toEqual(['iwings-digital.com', 'localhost']);
  });

  it('isPlatformHost / platformSubdomainOf with both domains listed', () => {
    const hosts = platformHosts(BOTH);
    expect(isPlatformHost('shopsdoor.com', hosts)).toBe(true);
    expect(isPlatformHost('www.shopsdoor.com:443', hosts)).toBe(true);
    expect(isPlatformHost('iwings-digital.com', hosts)).toBe(true);
    expect(isPlatformHost('namez.se', hosts)).toBe(false);

    expect(platformSubdomainOf('muba.shopsdoor.com', hosts)).toEqual({
      label: 'muba',
      platformHost: 'shopsdoor.com',
    });
    expect(platformSubdomainOf('muba.iwings-digital.com', hosts)).toEqual({
      label: 'muba',
      platformHost: 'iwings-digital.com',
    });
    expect(platformSubdomainOf('muba--eu.shopsdoor.com', hosts)).toEqual({
      label: 'muba--eu',
      platformHost: 'shopsdoor.com',
    });
    expect(platformSubdomainOf('shopsdoor.com', hosts)).toBeNull();
    expect(platformSubdomainOf('www.shopsdoor.com', hosts)).toBeNull();
    expect(platformSubdomainOf('namez.se', hosts)).toBeNull();
    expect(platformSubdomainOf('notshopsdoor.com', hosts)).toBeNull();
  });

  it('isReservedDomainFor: exact and subdomain of any listed host', () => {
    const hosts = platformHosts(BOTH);
    expect(isReservedDomainFor('admin.shopsdoor.com', hosts)).toBe(true);
    expect(isReservedDomainFor('Admin.IWINGS-digital.com ', hosts)).toBe(true);
    expect(isReservedDomainFor('shopsdoor.com', hosts)).toBe(true);
    expect(isReservedDomainFor('notshopsdoor.com', hosts)).toBe(false);
    expect(isReservedDomainFor('namez.se', hosts)).toBe(false);
  });
});
