import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { ConfigService } from '@nestjs/config';
import { mockClient } from 'aws-sdk-client-mock';
import { CryptoService } from './crypto.service';
import {
  decryptValue,
  encryptValue,
  encryptValueV2,
  isEncrypted,
  keyIdOf,
  loadKey,
} from './crypto.util';
import {
  KMS_ENCRYPTION_CONTEXT,
  unwrapDataKey,
  wrapDataKey,
} from './kms-key-source';

const DATA_KEY = Buffer.alloc(32, 7);
const DATA_KEY_B64 = DATA_KEY.toString('base64');
const WRAPPED_B64 = Buffer.from('kms-ciphertext-blob').toString('base64');

const kms = mockClient(KMSClient);

function configOf(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

beforeEach(() => {
  kms.reset();
});

describe('crypto.util', () => {
  it('keyIdOf is 8 bytes of sha256 as hex', () => {
    const id = keyIdOf(DATA_KEY);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(Buffer.alloc(32, 8))).not.toBe(id);
  });

  it('isEncrypted recognises v1 and v2, not plaintext', () => {
    expect(isEncrypted(encryptValue('x', DATA_KEY))).toBe(true);
    expect(isEncrypted(encryptValueV2('x', DATA_KEY))).toBe(true);
    expect(isEncrypted('sk_live_123')).toBe(false);
    expect(isEncrypted('v3:a:b:c')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it('v1 round trip; non-envelope values pass through', () => {
    const v = encryptValue('secret', DATA_KEY);
    expect(v.startsWith('v1:')).toBe(true);
    expect(v.split(':')).toHaveLength(4);
    expect(decryptValue(v, DATA_KEY)).toBe('secret');
    expect(decryptValue('plain', DATA_KEY)).toBe('plain');
  });

  it('v2 format is v2:<keyId>:<iv>:<tag>:<ciphertext> and decrypts with the matching key', () => {
    const v = encryptValueV2('secret', DATA_KEY);
    const parts = v.split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toBe(keyIdOf(DATA_KEY));
    expect(decryptValue(v, DATA_KEY)).toBe('secret');
  });

  it('v2 with another key id fails with a clear error', () => {
    const v = encryptValueV2('secret', Buffer.alloc(32, 9));
    expect(() => decryptValue(v, DATA_KEY)).toThrow(/uses data key/);
  });

  it('v2 with a tampered ciphertext fails the auth tag', () => {
    const parts = encryptValueV2('secret', DATA_KEY).split(':');
    parts[4] = Buffer.from('tampered').toString('base64');
    expect(() => decryptValue(parts.join(':'), DATA_KEY)).toThrow();
  });

  it('loadKey accepts base64 and hex, rejects wrong sizes', () => {
    expect(loadKey(DATA_KEY_B64)).toEqual(DATA_KEY);
    expect(loadKey(DATA_KEY.toString('hex'))).toEqual(DATA_KEY);
    expect(() => loadKey('short')).toThrow(/32 bytes/);
    expect(() => loadKey(undefined)).toThrow(/not set/);
  });
});

describe('kms-key-source', () => {
  it('unwrapDataKey sends Decrypt with the encryption context and key id', async () => {
    kms.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(DATA_KEY) });
    const key = await unwrapDataKey(WRAPPED_B64, {
      region: 'eu-north-1',
      keyId: 'alias/shopsdoor-envelope',
    });
    expect(key).toEqual(DATA_KEY);
    const calls = kms.commandCalls(DecryptCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.EncryptionContext).toEqual(KMS_ENCRYPTION_CONTEXT);
    expect(input.KeyId).toBe('alias/shopsdoor-envelope');
    expect(
      Buffer.from(input.CiphertextBlob as Uint8Array).toString('base64'),
    ).toBe(WRAPPED_B64);
  });

  it('unwrapDataKey omits KeyId when not configured', async () => {
    kms.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(DATA_KEY) });
    await unwrapDataKey(WRAPPED_B64, {});
    expect(
      kms.commandCalls(DecryptCommand)[0].args[0].input.KeyId,
    ).toBeUndefined();
  });

  it('unwrapDataKey rejects a plaintext that is not 32 bytes', async () => {
    kms.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(16) });
    await expect(unwrapDataKey(WRAPPED_B64, {})).rejects.toThrow(/32 bytes/);
  });

  it('wrapDataKey sends Encrypt with the context and returns base64 + key id', async () => {
    kms.on(EncryptCommand).resolves({
      CiphertextBlob: Buffer.from('kms-ciphertext-blob'),
      KeyId: 'arn:aws:kms:eu-north-1:123:key/abc',
    });
    const out = await wrapDataKey(DATA_KEY, {
      keyId: 'alias/shopsdoor-envelope',
    });
    expect(out).toEqual({
      wrappedBase64: WRAPPED_B64,
      kmsKeyId: 'arn:aws:kms:eu-north-1:123:key/abc',
    });
    const input = kms.commandCalls(EncryptCommand)[0].args[0].input;
    expect(input.EncryptionContext).toEqual(KMS_ENCRYPTION_CONTEXT);
    expect(input.KeyId).toBe('alias/shopsdoor-envelope');
  });
});

describe('CryptoService', () => {
  it('env mode: unchanged behaviour, no KMS call, describe() says env', async () => {
    const svc = new CryptoService(configOf({ ENCRYPTION_KEY: DATA_KEY_B64 }));
    await svc.onModuleInit();
    expect(kms.calls()).toHaveLength(0);
    const enc = svc.encrypt('hello') as string;
    expect(enc.startsWith('v1:')).toBe(true);
    expect(svc.decrypt(enc)).toBe('hello');
    expect(svc.decrypt('legacy')).toBe('legacy');
    expect(svc.decrypt(null)).toBeNull();
    expect(svc.encrypt('')).toBeNull();
    expect(svc.isEncrypted(enc)).toBe(true);
    expect(svc.describe()).toEqual({ source: 'env', keyId: keyIdOf(DATA_KEY) });
  });

  it('env mode: key is ready synchronously (legacy callers that do not await)', () => {
    const svc = new CryptoService(configOf({ ENCRYPTION_KEY: DATA_KEY_B64 }));
    void svc.onModuleInit();
    expect(svc.decrypt(svc.encrypt('x'))).toBe('x');
  });

  it('env mode: refuses to start without any key', async () => {
    const svc = new CryptoService(configOf({}));
    await expect(svc.onModuleInit()).rejects.toThrow(
      /ENCRYPTION_KEY is not set/,
    );
  });

  it('wrapped mode: unwraps via KMS and encrypt still produces v1', async () => {
    kms.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(DATA_KEY) });
    const svc = new CryptoService(
      configOf({
        ENCRYPTION_KEY_WRAPPED: WRAPPED_B64,
        AWS_REGION: 'eu-north-1',
        KMS_KEY_ID: 'alias/shopsdoor-envelope',
      }),
    );
    await svc.onModuleInit();
    expect(kms.commandCalls(DecryptCommand)).toHaveLength(1);
    expect(svc.describe()).toEqual({ source: 'kms', keyId: keyIdOf(DATA_KEY) });

    // Same data key as env mode: rows written before the envelope still decrypt.
    const fromEnv = encryptValue('hello', DATA_KEY);
    expect(svc.decrypt(fromEnv)).toBe('hello');
    const enc = svc.encrypt('hello') as string;
    expect(enc.startsWith('v1:')).toBe(true);
    expect(svc.decrypt(enc)).toBe('hello');
    expect(svc.decrypt(encryptValueV2('v2 row', DATA_KEY))).toBe('v2 row');
  });

  it('wrapped mode: wrapped wins over plaintext and warns', async () => {
    kms.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(DATA_KEY) });
    const svc = new CryptoService(
      configOf({
        ENCRYPTION_KEY_WRAPPED: WRAPPED_B64,
        ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      }),
    );
    const warn = jest
      .spyOn(
        (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    await svc.onModuleInit();
    expect(svc.describe()).toEqual({ source: 'kms', keyId: keyIdOf(DATA_KEY) });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Remove the plaintext'),
    );
    expect(warn.mock.calls[0][0]).not.toContain(DATA_KEY_B64);
  });

  it('wrapped mode: getKey before init refuses lazy loading', () => {
    const svc = new CryptoService(
      configOf({ ENCRYPTION_KEY_WRAPPED: WRAPPED_B64 }),
    );
    expect(() => svc.encrypt('x')).toThrow(/not initialised/);
  });

  describe('unwrap failure', () => {
    const failing = () => {
      kms.on(DecryptCommand).rejects(
        Object.assign(new Error('User is not authorized'), {
          name: 'AccessDeniedException',
        }),
      );
    };

    it('strict (explicit true): refuses to start, logs the error class only', async () => {
      failing();
      const svc = new CryptoService(
        configOf({
          ENCRYPTION_KEY_WRAPPED: WRAPPED_B64,
          ENCRYPTION_KEY: DATA_KEY_B64,
          CRYPTO_STRICT_STARTUP: 'true',
        }),
      );
      const logger = (
        svc as unknown as {
          logger: { error: (m: string) => void; warn: (m: string) => void };
        }
      ).logger;
      const error = jest
        .spyOn(logger, 'error')
        .mockImplementation(() => undefined);
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await expect(svc.onModuleInit()).rejects.toThrow(/KMS unwrap failed/);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('AccessDeniedException'),
      );
      expect(error.mock.calls[0][0]).not.toContain(DATA_KEY_B64);
      expect(error.mock.calls[0][0]).not.toContain(WRAPPED_B64);
    });

    it('strict by default in production', async () => {
      failing();
      const svc = new CryptoService(
        configOf({
          ENCRYPTION_KEY_WRAPPED: WRAPPED_B64,
          ENCRYPTION_KEY: DATA_KEY_B64,
          NODE_ENV: 'production',
        }),
      );
      const logger = (
        svc as unknown as {
          logger: { error: (m: string) => void; warn: (m: string) => void };
        }
      ).logger;
      jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await expect(svc.onModuleInit()).rejects.toThrow(/KMS unwrap failed/);
    });

    it('non-strict with plaintext present: falls back to env', async () => {
      failing();
      const svc = new CryptoService(
        configOf({
          ENCRYPTION_KEY_WRAPPED: WRAPPED_B64,
          ENCRYPTION_KEY: DATA_KEY_B64,
          NODE_ENV: 'development',
        }),
      );
      const logger = (
        svc as unknown as { logger: { warn: (m: string) => void } }
      ).logger;
      const warn = jest
        .spyOn(logger, 'warn')
        .mockImplementation(() => undefined);
      await svc.onModuleInit();
      expect(svc.describe()).toEqual({
        source: 'env',
        keyId: keyIdOf(DATA_KEY),
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('falling back'),
      );
    });

    it('production with CRYPTO_STRICT_STARTUP=false: falls back (trial period)', async () => {
      failing();
      const svc = new CryptoService(
        configOf({
          ENCRYPTION_KEY_WRAPPED: WRAPPED_B64,
          ENCRYPTION_KEY: DATA_KEY_B64,
          NODE_ENV: 'production',
          CRYPTO_STRICT_STARTUP: 'false',
        }),
      );
      const logger = (
        svc as unknown as { logger: { warn: (m: string) => void } }
      ).logger;
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await svc.onModuleInit();
      expect(svc.describe().source).toBe('env');
    });

    it('non-strict without plaintext: refuses to start', async () => {
      failing();
      const svc = new CryptoService(
        configOf({
          ENCRYPTION_KEY_WRAPPED: WRAPPED_B64,
          NODE_ENV: 'development',
        }),
      );
      const logger = (
        svc as unknown as { logger: { error: (m: string) => void } }
      ).logger;
      jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      await expect(svc.onModuleInit()).rejects.toThrow(/KMS unwrap failed/);
    });
  });
});
