import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import { assertKeyBytes } from './crypto.util';

/**
 * KMS envelope for the app data key (Phase 4 of the S3/KMS plan).
 *
 * The 32-byte AES data key is stored only as a KMS ciphertext
 * (`ENCRYPTION_KEY_WRAPPED`, base64 of the KMS CiphertextBlob). One KMS
 * Decrypt at startup turns it back into the in-memory key; the sync
 * encrypt/decrypt API of CryptoService is unchanged. The encryption context
 * below is bound into the ciphertext: a Decrypt without the same context
 * fails, so a wrapped value cannot be reused for another purpose.
 */

/** Bound into every KMS Encrypt/Decrypt of the data key. Never change it. */
export const KMS_ENCRYPTION_CONTEXT: Readonly<Record<string, string>> = {
  app: 'shopsdoor',
  purpose: 'encryption-key',
};

export interface KmsKeySourceOptions {
  /** AWS region (`AWS_REGION`). The SDK default chain supplies credentials. */
  region?: string;
  /** Key id, ARN or alias (`KMS_KEY_ID`). Optional for symmetric Decrypt. */
  keyId?: string;
  /** Test seam: inject a pre-built client. */
  client?: KMSClient;
}

export function createKmsClient(opts: KmsKeySourceOptions): KMSClient {
  if (opts.client) return opts.client;
  const config: KMSClientConfig = {};
  if (opts.region?.trim()) config.region = opts.region.trim();
  return new KMSClient(config);
}

/** KMS Decrypt of the wrapped data key; returns the 32-byte plaintext key. */
export async function unwrapDataKey(
  wrappedBase64: string,
  opts: KmsKeySourceOptions,
): Promise<Buffer> {
  const blob = Buffer.from(wrappedBase64.trim(), 'base64');
  if (blob.length === 0) {
    throw new Error('ENCRYPTION_KEY_WRAPPED is not valid base64');
  }
  const client = createKmsClient(opts);
  const out = await client.send(
    new DecryptCommand({
      CiphertextBlob: blob,
      EncryptionContext: { ...KMS_ENCRYPTION_CONTEXT },
      ...(opts.keyId?.trim() ? { KeyId: opts.keyId.trim() } : {}),
    }),
  );
  return assertKeyBytes(out.Plaintext, 'KMS-unwrapped data key');
}

/** KMS Encrypt of the plaintext data key; returns base64 ciphertext + key id. */
export async function wrapDataKey(
  key: Buffer,
  opts: KmsKeySourceOptions & { keyId: string },
): Promise<{ wrappedBase64: string; kmsKeyId: string }> {
  assertKeyBytes(key, 'Data key');
  const client = createKmsClient(opts);
  const out = await client.send(
    new EncryptCommand({
      KeyId: opts.keyId.trim(),
      Plaintext: key,
      EncryptionContext: { ...KMS_ENCRYPTION_CONTEXT },
    }),
  );
  if (!out.CiphertextBlob || out.CiphertextBlob.length === 0) {
    throw new Error('KMS Encrypt returned no ciphertext');
  }
  return {
    wrappedBase64: Buffer.from(out.CiphertextBlob).toString('base64'),
    kmsKeyId: out.KeyId ?? opts.keyId,
  };
}
