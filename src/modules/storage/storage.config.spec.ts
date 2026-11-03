import {
  describeStorageConfig,
  isS3Driver,
  parseStorageConfig,
  StorageConfigError,
  storageDriver,
} from './storage.config';

describe('storage config', () => {
  const cwd = process.platform === 'win32' ? 'C:\\app' : '/app';

  it('defaults to the local driver with local roots', () => {
    const cfg = parseStorageConfig({}, cwd);
    expect(cfg.driver).toBe('local');
    expect(cfg.backupDriver).toBe('local');
    expect(cfg.mediaLocalFallback).toBe(true);
    expect(cfg.strictStartup).toBe(true);
    expect(cfg.local.uploadsDir.endsWith('uploads')).toBe(true);
    expect(cfg.credentialsInEnv).toBe(false);
    expect(cfg.mediaPrefix).toBe('media/');
    expect(cfg.privatePrefix).toBe('private/');
    expect(cfg.backupPrefix).toBe('backups/');
    expect(cfg.deleteMode).toBe('try');
    expect(cfg.backupObjectLock).toBe(false);
    expect(storageDriver({})).toBe('local');
    expect(isS3Driver({})).toBe(false);
  });

  it('requires the buckets and region in s3 mode, with a clear message', () => {
    expect(() => parseStorageConfig({ STORAGE_DRIVER: 's3' }, cwd)).toThrow(
      /STORAGE_DRIVER=s3 needs S3_MEDIA_BUCKET, S3_PRIVATE_BUCKET, AWS_REGION/,
    );
    expect(() => parseStorageConfig({ STORAGE_DRIVER: 'gcs' }, cwd)).toThrow(
      StorageConfigError,
    );
    expect(() =>
      parseStorageConfig(
        { STORAGE_DRIVER: 's3', S3_MEDIA_BUCKET: 'Bad Name' },
        cwd,
      ),
    ).toThrow(/S3_MEDIA_BUCKET is not a valid bucket name/);
    expect(() =>
      parseStorageConfig({ MEDIA_LOCAL_FALLBACK: 'maybe' }, cwd),
    ).toThrow(/MEDIA_LOCAL_FALLBACK must be true or false/);
    expect(() =>
      parseStorageConfig({ S3_BACKUP_BUCKET: 'backups' }, cwd),
    ).toThrow(/S3_BACKUP_BUCKET needs AWS_REGION/);
  });

  it('parses a full s3 setup and keeps secrets out of the description', () => {
    const cfg = parseStorageConfig(
      {
        STORAGE_DRIVER: 's3',
        AWS_REGION: 'eu-north-1',
        AWS_ACCESS_KEY_ID: 'AKIA',
        AWS_SECRET_ACCESS_KEY: 'secret',
        S3_MEDIA_BUCKET: 'shopsdoor-prod-media',
        S3_PRIVATE_BUCKET: 'shopsdoor-prod-private',
        S3_BACKUP_BUCKET: 'shopsdoor-prod-backups',
        S3_KMS_KEY_ID: 'arn:aws:kms:eu-north-1:1:key/x',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_FORCE_PATH_STYLE: 'true',
        MEDIA_LOCAL_FALLBACK: 'false',
        STORAGE_STRICT_STARTUP: 'off',
        PUBLIC_API_URL: 'https://api.example.com/',
      },
      cwd,
    );
    expect(cfg).toMatchObject({
      driver: 's3',
      backupDriver: 's3',
      region: 'eu-north-1',
      mediaBucket: 'shopsdoor-prod-media',
      privateBucket: 'shopsdoor-prod-private',
      backupBucket: 'shopsdoor-prod-backups',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      mediaLocalFallback: false,
      strictStartup: false,
      mediaBaseUrl: 'https://api.example.com',
      credentialsInEnv: true,
    });
    const described = JSON.stringify(describeStorageConfig(cfg));
    expect(described).not.toContain('secret');
    expect(described).not.toContain('AKIA');
    expect(described).not.toContain('key/x');
    expect(described).toContain('"kms":true');
    expect(described).toContain('"credentials_in_env":true');
    expect(described).toContain('"delete_mode":"try"');
    expect(described).toContain('"backup_object_lock":false');
    expect(described).toContain('"media_prefix":"media/"');
  });

  it('single bucket for all roles: prefixes keep them apart, normalised to end with /', () => {
    const cfg = parseStorageConfig(
      {
        STORAGE_DRIVER: 's3',
        AWS_REGION: 'us-east-1',
        S3_MEDIA_BUCKET: 'shopsdoor',
        S3_PRIVATE_BUCKET: 'shopsdoor',
        S3_BACKUP_BUCKET: 'shopsdoor',
        S3_MEDIA_PREFIX: '/public',
        S3_PRIVATE_PREFIX: 'priv//',
        S3_BACKUP_PREFIX: ' archive/2026 ',
        STORAGE_DELETE_MODE: 'skip',
        S3_BACKUP_OBJECT_LOCK: 'true',
      },
      cwd,
    );
    expect(cfg).toMatchObject({
      mediaPrefix: 'public/',
      privatePrefix: 'priv/',
      backupPrefix: 'archive/2026/',
      deleteMode: 'skip',
      backupObjectLock: true,
      kmsKeyId: null,
    });
    // Set-but-empty = no prefix (allowed when the buckets differ).
    expect(
      parseStorageConfig(
        {
          STORAGE_DRIVER: 's3',
          AWS_REGION: 'us-east-1',
          S3_MEDIA_BUCKET: 'media',
          S3_PRIVATE_BUCKET: 'private',
          S3_MEDIA_PREFIX: '',
          S3_PRIVATE_PREFIX: '',
        },
        cwd,
      ),
    ).toMatchObject({ mediaPrefix: '', privatePrefix: '' });
  });

  it('refuses two roles on the same bucket with the same prefix, and bad values', () => {
    const base = {
      STORAGE_DRIVER: 's3',
      AWS_REGION: 'us-east-1',
      S3_MEDIA_BUCKET: 'one',
      S3_PRIVATE_BUCKET: 'one',
    };
    expect(() =>
      parseStorageConfig({ ...base, S3_PRIVATE_PREFIX: 'media/' }, cwd),
    ).toThrow(
      /media and private share bucket "one" with the same key prefix "media\/"/,
    );
    expect(() =>
      parseStorageConfig(
        { ...base, S3_MEDIA_PREFIX: '', S3_PRIVATE_PREFIX: '' },
        cwd,
      ),
    ).toThrow(/same key prefix ""/);
    expect(() =>
      parseStorageConfig(
        { ...base, S3_BACKUP_BUCKET: 'one', S3_BACKUP_PREFIX: 'private' },
        cwd,
      ),
    ).toThrow(/private and backup share bucket "one"/);
    expect(() =>
      parseStorageConfig({ ...base, S3_MEDIA_PREFIX: '../x' }, cwd),
    ).toThrow(/S3_MEDIA_PREFIX is not a valid key prefix/);
    expect(() =>
      parseStorageConfig({ STORAGE_DELETE_MODE: 'maybe' }, cwd),
    ).toThrow(/STORAGE_DELETE_MODE must be "try" or "skip"/);
    expect(() =>
      parseStorageConfig({ S3_BACKUP_OBJECT_LOCK: 'yes please' }, cwd),
    ).toThrow(/S3_BACKUP_OBJECT_LOCK must be true or false/);
  });

  it('MEDIA_BASE_URL defaults to the API origin (PUBLIC_API_URL)', () => {
    expect(
      parseStorageConfig({ PUBLIC_API_URL: 'https://api.example.com/' }, cwd)
        .mediaBaseUrl,
    ).toBe('https://api.example.com');
    expect(parseStorageConfig({}, cwd).mediaBaseUrl).toBeNull();
  });

  it('backups go offsite with the local driver when the backup bucket is set', () => {
    const cfg = parseStorageConfig(
      { S3_BACKUP_BUCKET: 'shopsdoor-prod-backups', AWS_REGION: 'eu-north-1' },
      cwd,
    );
    expect(cfg.driver).toBe('local');
    expect(cfg.backupDriver).toBe('s3');
    expect(isS3Driver({ STORAGE_DRIVER: 's3' })).toBe(true);
  });
});
