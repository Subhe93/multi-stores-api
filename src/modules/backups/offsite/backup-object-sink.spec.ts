import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'stream';
import {
  appManifestKey,
  backupTier,
  dbObjectKey,
  filesObjectKey,
  NoopBackupObjectSink,
  offsiteDate,
  retainUntilFor,
  tierOptions,
} from './backup-object-sink';
import { createBackupObjectSink } from './backup-sink.provider';
import {
  BACKUP_S3_REQUEST_TIMEOUT_MS,
  S3BackupObjectSink,
  s3BackupSinkConfigFromEnv,
} from './s3-backup-sink';

/**
 * Sink selection from the environment, the key layout, the retention tiers,
 * and the S3 sink's use of the SDK (SSE, metadata, checksum, tagging, Object
 * Lock, List-based verification, pagination) against a mocked client.
 */

const quiet = { log: jest.fn(), warn: jest.fn() };

describe('key layout', () => {
  const at = new Date('2026-11-03T23:30:00Z');
  it('puts dumps, archives and markers under their date folders', () => {
    expect(offsiteDate(at)).toBe('2026-11-03');
    expect(dbObjectKey(at, 'db-20261103-233000-abcd1234.dump')).toBe(
      'db/2026-11-03/db-20261103-233000-abcd1234.dump',
    );
    expect(filesObjectKey(at, 'uploads-x.tar.gz')).toBe(
      'files/2026-11-03/uploads-x.tar.gz',
    );
    expect(appManifestKey(at, 'abcd1234-0000')).toBe(
      'manifests/2026-11-03-app-abcd1234.json',
    );
  });
});

describe('retention tiers (INFRA.md §3.5)', () => {
  it('is monthly on the 1st, weekly on a Sunday, daily otherwise', () => {
    expect(backupTier(new Date('2026-11-01T03:00:00Z'))).toBe('monthly'); // a Sunday too
    expect(backupTier(new Date('2026-11-08T03:00:00Z'))).toBe('weekly');
    expect(backupTier(new Date('2026-11-03T03:00:00Z'))).toBe('daily');
  });

  it('locks weekly 56 d and monthly 365 d; daily keeps the bucket default', () => {
    const at = new Date('2026-11-08T03:00:00Z');
    expect(retainUntilFor('daily', at)).toBeNull();
    expect(retainUntilFor('weekly', at)).toEqual(
      new Date('2027-01-03T03:00:00Z'),
    );
    expect(retainUntilFor('monthly', at)).toEqual(
      new Date('2027-11-08T03:00:00Z'),
    );
    expect(tierOptions(new Date('2026-11-03T03:00:00Z'))).toEqual({
      tier: 'daily',
    });
    expect(tierOptions(at)).toEqual({
      tier: 'weekly',
      retainUntil: new Date('2027-01-03T03:00:00Z'),
    });
  });
});

describe('createBackupObjectSink', () => {
  it('is the no-op sink without a bucket (local driver)', async () => {
    const sink = createBackupObjectSink({ STORAGE_DRIVER: 'local' }, quiet);
    expect(sink).toBeInstanceOf(NoopBackupObjectSink);
    expect(sink.enabled).toBe(false);
    await expect(
      sink.put('k', Buffer.from(''), { contentType: 'x' }),
    ).rejects.toThrow(/BACKUP_OFFSITE_DISABLED/);
    expect(await sink.sizeOf('k')).toBeNull();
    expect(await sink.head('k')).toBeNull();
    expect(await sink.list('manifests/')).toEqual([]);
  });

  it('warns but stays local when the driver is s3 and no bucket is set', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };
    expect(
      createBackupObjectSink({ STORAGE_DRIVER: 's3' }, logger).enabled,
    ).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('S3_BACKUP_BUCKET'),
    );
  });

  it('uploads whenever a bucket is set, even with the local driver, without logging secrets', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };
    const sink = createBackupObjectSink(
      {
        STORAGE_DRIVER: 'local',
        AWS_REGION: 'eu-north-1',
        S3_BACKUP_BUCKET: 'shopsdoor-prod-backups',
        S3_KMS_KEY_ID: 'arn:aws:kms:eu-north-1:1:key/abc',
        AWS_ACCESS_KEY_ID: 'AKIASECRET',
        AWS_SECRET_ACCESS_KEY: 'verysecret',
        BACKUP_AWS_ACCESS_KEY_ID: 'AKIAWRITER',
        BACKUP_AWS_SECRET_ACCESS_KEY: 'writersecret',
      },
      logger,
    );
    expect(sink).toBeInstanceOf(S3BackupObjectSink);
    expect(sink.enabled).toBe(true);
    expect(sink.target).toBe('s3://shopsdoor-prod-backups/backups/');
    const line = String(logger.log.mock.calls[0][0]);
    expect(line).toContain('kms=true');
    expect(line).toContain('object_lock=false');
    expect(line).toContain('backup_credentials=true');
    for (const secret of [
      'AKIASECRET',
      'verysecret',
      'AKIAWRITER',
      'writersecret',
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it('parses the env exactly like the storage core', () => {
    expect(
      s3BackupSinkConfigFromEnv({
        S3_BACKUP_BUCKET: 'bkt',
        S3_ENDPOINT: 'http://minio:9000',
        S3_FORCE_PATH_STYLE: 'true',
        AWS_REGION: 'eu-north-1',
        BACKUP_AWS_ACCESS_KEY_ID: 'id',
        BACKUP_AWS_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toEqual({
      bucket: 'bkt',
      keyPrefix: 'backups/',
      region: 'eu-north-1',
      kmsKeyId: undefined,
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
      objectLock: false,
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
    // Single bucket for every role: prefixes keep them apart; the API key
    // (no BACKUP_AWS_*) is used.
    expect(
      s3BackupSinkConfigFromEnv({
        STORAGE_DRIVER: 's3',
        AWS_REGION: 'us-east-1',
        S3_MEDIA_BUCKET: 'one',
        S3_PRIVATE_BUCKET: 'one',
        S3_BACKUP_BUCKET: 'one',
        S3_BACKUP_PREFIX: 'archive',
        S3_BACKUP_OBJECT_LOCK: 'true',
      }),
    ).toMatchObject({ bucket: 'one', keyPrefix: 'archive/', objectLock: true });
    expect(s3BackupSinkConfigFromEnv({ S3_BACKUP_BUCKET: '  ' })).toBeNull();
    // Same validation as the storage module: a bucket needs the region.
    expect(() =>
      s3BackupSinkConfigFromEnv({ S3_BACKUP_BUCKET: 'bkt' }),
    ).toThrow(/AWS_REGION/);
    // A broken storage env without a backup bucket just means "sink off".
    expect(s3BackupSinkConfigFromEnv({ STORAGE_DRIVER: 's3' })).toBeNull();
  });
});

describe('S3BackupObjectSink (mocked client)', () => {
  const client = new S3Client({ region: 'eu-north-1' });
  const stub = mockClient(client);

  beforeEach(() => stub.reset());
  afterAll(() => stub.restore());

  it('puts with SSE-KMS, sha256 metadata + ChecksumSHA256, and (opt-in) tier tag + Object Lock', async () => {
    const sink = new S3BackupObjectSink(
      {
        bucket: 'b',
        keyPrefix: '',
        region: 'eu-north-1',
        kmsKeyId: 'key-1',
        objectLock: true,
      },
      client,
    );
    stub.on(PutObjectCommand).resolves({ ETag: '"abc"' });
    const sha = 'a'.repeat(64);
    const until = new Date('2027-01-03T03:00:00Z');
    const out = await sink.put('db/2026-11-03/x.dump', Readable.from(['x']), {
      contentType: 'application/octet-stream',
      contentLength: 1,
      sha256: sha,
      tier: 'weekly',
      retainUntil: until,
    });
    expect(out).toEqual({ etag: 'abc', size: 1 });
    const put = stub.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put).toMatchObject({
      Bucket: 'b',
      Key: 'db/2026-11-03/x.dump',
      ContentLength: 1,
      ContentType: 'application/octet-stream',
      Metadata: { sha256: sha },
      ChecksumSHA256: Buffer.from(sha, 'hex').toString('base64'),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'key-1',
      Tagging: 'tier=weekly',
      ObjectLockMode: 'GOVERNANCE',
      ObjectLockRetainUntilDate: until,
    });
  });

  it('default (no Object Lock, no KMS): plain PutObject under the prefix, no tag, no lock, no SSE header', async () => {
    const sink = new S3BackupObjectSink({ bucket: 'b' }, client);
    expect(sink.keyPrefix).toBe('backups/');
    expect(sink.target).toBe('s3://b/backups/');
    stub.on(PutObjectCommand).resolves({});
    await sink.put('k', Buffer.from('xy'), {
      contentType: 't',
      tier: 'weekly',
      retainUntil: new Date('2027-01-03T03:00:00Z'),
    });
    const put = stub.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put).toMatchObject({ Key: 'backups/k', ContentLength: 2 });
    expect(put).not.toHaveProperty('ServerSideEncryption');
    expect(put).not.toHaveProperty('SSEKMSKeyId');
    expect(put).not.toHaveProperty('Tagging');
    expect(put).not.toHaveProperty('ObjectLockMode');
    expect(put).not.toHaveProperty('ObjectLockRetainUntilDate');
    // Object Lock on, daily: tag but no per-object lock.
    const locking = new S3BackupObjectSink(
      { bucket: 'b', keyPrefix: '', objectLock: true },
      client,
    );
    await locking.put('k', Buffer.from('xy'), {
      contentType: 't',
      tier: 'daily',
    });
    const daily = stub.commandCalls(PutObjectCommand)[1].args[0].input;
    expect(daily).toMatchObject({ Key: 'k', Tagging: 'tier=daily' });
    expect(daily).not.toHaveProperty('ObjectLockMode');
    await expect(
      sink.put('k', Readable.from(['x']), { contentType: 't' }),
    ).rejects.toThrow(/contentLength/);
  });

  it('sizeOf verifies through ListObjectsV2 on the exact key (no HeadObject)', async () => {
    const sink = new S3BackupObjectSink({ bucket: 'b', keyPrefix: '' }, client);
    stub
      .on(ListObjectsV2Command, { Prefix: 'db/2026-11-03/x.dump' })
      .resolvesOnce({
        Contents: [{ Key: 'db/2026-11-03/x.dump.old', Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: 't2',
      })
      .resolvesOnce({ Contents: [{ Key: 'db/2026-11-03/x.dump', Size: 5 }] });
    expect(await sink.sizeOf('db/2026-11-03/x.dump')).toBe(5);
    expect(stub.commandCalls(HeadObjectCommand)).toHaveLength(0);
    stub
      .on(ListObjectsV2Command, { Prefix: 'missing' })
      .resolves({ Contents: [] });
    expect(await sink.sizeOf('missing')).toBeNull();
  });

  it('head/get answer null on 404, lower-case the metadata and explain a write-only key', async () => {
    const sink = new S3BackupObjectSink({ bucket: 'b', keyPrefix: '' }, client);
    stub
      .on(HeadObjectCommand)
      .resolvesOnce({
        ContentLength: 5,
        ETag: '"e"',
        LastModified: new Date('2026-11-03T03:40:00Z'),
        Metadata: { SHA256: 'ff' },
      })
      .rejectsOnce(Object.assign(new Error('nf'), { name: 'NotFound' }));
    stub
      .on(GetObjectCommand)
      .rejectsOnce(
        Object.assign(new Error('nf'), { $metadata: { httpStatusCode: 404 } }),
      )
      .rejectsOnce(
        Object.assign(new Error('denied'), { name: 'AccessDenied' }),
      );
    expect(await sink.head('k')).toEqual({
      size: 5,
      etag: 'e',
      lastModified: new Date('2026-11-03T03:40:00Z'),
      metadata: { sha256: 'ff' },
    });
    expect(await sink.head('k')).toBeNull();
    expect(await sink.get('k')).toBeNull();
    await expect(sink.get('k')).rejects.toThrow(/BACKUP_OFFSITE_READ_DENIED/);
  });

  it('list follows pagination', async () => {
    const sink = new S3BackupObjectSink({ bucket: 'b', keyPrefix: '' }, client);
    stub
      .on(ListObjectsV2Command, { Prefix: 'manifests/' })
      .resolvesOnce({
        Contents: [{ Key: 'manifests/2026-11-01.json', Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: 't2',
      })
      .resolvesOnce({
        Contents: [
          {
            Key: 'manifests/2026-11-02.json',
            Size: 2,
            LastModified: new Date('2026-11-02T03:40:00Z'),
          },
        ],
      });
    expect(await sink.list('manifests/')).toEqual([
      { key: 'manifests/2026-11-01.json', size: 1, lastModified: null },
      {
        key: 'manifests/2026-11-02.json',
        size: 2,
        lastModified: new Date('2026-11-02T03:40:00Z'),
      },
    ]);
    const second = stub.commandCalls(ListObjectsV2Command)[1].args[0].input;
    expect(second).toMatchObject({
      Prefix: 'manifests/',
      ContinuationToken: 't2',
    });
  });

  it('prefixes sizeOf/list/get with the role prefix and answers role-relative keys', async () => {
    const sink = new S3BackupObjectSink({ bucket: 'b' }, client);
    stub
      .on(ListObjectsV2Command, { Prefix: 'backups/db/2026-11-03/x.dump' })
      .resolves({
        Contents: [{ Key: 'backups/db/2026-11-03/x.dump', Size: 5 }],
      });
    expect(await sink.sizeOf('db/2026-11-03/x.dump')).toBe(5);
    stub.on(ListObjectsV2Command, { Prefix: 'backups/manifests/' }).resolves({
      Contents: [
        { Key: 'backups/manifests/2026-11-01.json', Size: 1 },
        { Key: 'backups/manifests/2026-11-02.json', Size: 2 },
      ],
    });
    expect((await sink.list('manifests/')).map((o) => o.key)).toEqual([
      'manifests/2026-11-01.json',
      'manifests/2026-11-02.json',
    ]);
    stub.on(GetObjectCommand).resolves({
      Body: Readable.from(['x']) as never,
      ContentLength: 1,
    });
    await sink.get('db/2026-11-03/x.dump');
    expect(stub.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'backups/db/2026-11-03/x.dump',
    });
  });

  it('builds its client lazily with the writer credentials and a long socket timeout', () => {
    expect(BACKUP_S3_REQUEST_TIMEOUT_MS).toBeGreaterThan(60_000);
    const sink = new S3BackupObjectSink({
      bucket: 'b',
      region: 'eu-north-1',
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
    // Nothing is constructed until the first call.
    expect((sink as unknown as { client: unknown }).client).toBeNull();
  });
});
