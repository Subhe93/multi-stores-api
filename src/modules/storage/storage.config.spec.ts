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
