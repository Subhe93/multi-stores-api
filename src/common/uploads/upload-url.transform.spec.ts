import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  validateSync,
} from 'class-validator';
import {
  apiUploadHosts,
  normalizeApiUploadJson,
  normalizeApiUploadUrl,
  UploadUrl,
  UploadUrlsInJson,
} from './upload-url.transform';

class SampleDto {
  @IsOptional()
  @IsString()
  @UploadUrl()
  url?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @UploadUrl()
  urls?: string[];

  @IsOptional()
  @IsObject()
  @UploadUrlsInJson()
  settings?: Record<string, unknown> | null;
}

describe('upload URL write-path normalisation', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.PUBLIC_API_URL = 'https://ms-api.shopsdoor.com';
    process.env.API_PUBLIC_ORIGINS =
      'https://api.example.com, http://127.0.0.1:3001';
    delete process.env.MEDIA_BASE_URL;
  });
  afterAll(() => {
    process.env = env;
  });

  it('collects the hosts from PUBLIC_API_URL, API_PUBLIC_ORIGINS and MEDIA_BASE_URL', () => {
    process.env.MEDIA_BASE_URL = 'https://cdn.shopsdoor.com/';
    expect(apiUploadHosts()).toEqual([
      'https://ms-api.shopsdoor.com',
      'https://api.example.com',
      'http://127.0.0.1:3001',
      'https://cdn.shopsdoor.com/',
    ]);
    expect(apiUploadHosts({})).toEqual([]);
  });

  it('rewrites only our hosts; foreign URLs, relative paths and non-strings pass through', () => {
    expect(
      normalizeApiUploadUrl(
        'https://ms-api.shopsdoor.com/uploads/products/a.webp',
      ),
    ).toBe('/uploads/products/a.webp');
    expect(
      normalizeApiUploadUrl('http://127.0.0.1:3001/uploads/logos/x.svg?v=1'),
    ).toBe('/uploads/logos/x.svg');
    expect(normalizeApiUploadUrl('http://localhost:3001/uploads/a/b.png')).toBe(
      '/uploads/a/b.png',
    );
    expect(normalizeApiUploadUrl('https://cdn.other.com/uploads/a/b.png')).toBe(
      'https://cdn.other.com/uploads/a/b.png',
    );
    expect(normalizeApiUploadUrl('/uploads/products/a.webp')).toBe(
      '/uploads/products/a.webp',
    );
    expect(normalizeApiUploadUrl('https://ms-api.shopsdoor.com/api/x')).toBe(
      'https://ms-api.shopsdoor.com/api/x',
    );
    expect(normalizeApiUploadUrl(null)).toBeNull();
    expect(normalizeApiUploadUrl(undefined)).toBeUndefined();
    expect(normalizeApiUploadUrl(42)).toBe(42);
  });

  it('walks JSON values and keeps everything else identical', () => {
    const input = {
      hero: {
        image: 'https://ms-api.shopsdoor.com/uploads/store-hero/h.webp',
        html: '<img src="https://ms-api.shopsdoor.com/uploads/page-blocks/i.webp"> and <img src="https://x.com/uploads/k.png">',
      },
      list: ['https://api.example.com/uploads/a/b.webp', 7, null, true],
      untouched: 'plain text',
    };
    expect(normalizeApiUploadJson(input)).toEqual({
      hero: {
        image: '/uploads/store-hero/h.webp',
        html: '<img src="/uploads/page-blocks/i.webp"> and <img src="https://x.com/uploads/k.png">',
      },
      list: ['/uploads/a/b.webp', 7, null, true],
      untouched: 'plain text',
    });
    expect(normalizeApiUploadJson(null)).toBeNull();
    expect(
      normalizeApiUploadJson('https://ms-api.shopsdoor.com/uploads/a/b.webp'),
    ).toBe('https://ms-api.shopsdoor.com/uploads/a/b.webp');
  });

  it('runs inside class-transformer DTOs before validation', () => {
    const dto = plainToInstance(SampleDto, {
      url: 'https://ms-api.shopsdoor.com/uploads/avatars/u.webp',
      urls: [
        'https://api.example.com/uploads/custom-products/m1.webp',
        'https://foreign.example/uploads/x.png',
      ],
      settings: {
        og_image: 'https://ms-api.shopsdoor.com/uploads/page-seo/og.webp',
      },
    });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.url).toBe('/uploads/avatars/u.webp');
    expect(dto.urls).toEqual([
      '/uploads/custom-products/m1.webp',
      'https://foreign.example/uploads/x.png',
    ]);
    expect(dto.settings).toEqual({ og_image: '/uploads/page-seo/og.webp' });

    // Wrong types still reach the validators unchanged.
    const bad = plainToInstance(SampleDto, { url: 5, settings: 'nope' });
    expect(bad.url).toBe(5);
    expect(bad.settings).toBe('nope');
    expect(validateSync(bad).length).toBeGreaterThan(0);
    const empty = plainToInstance(SampleDto, { url: null, settings: null });
    expect(empty.url).toBeNull();
    expect(empty.settings).toBeNull();
  });
});
