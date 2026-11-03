import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decryptValue,
  encryptValue,
  isEncrypted,
  keyIdOf,
  loadKey,
} from './crypto.util';
import { unwrapDataKey } from './kms-key-source';

export type CryptoKeySource = 'kms' | 'env';

/** Non-secret description of the active data key, for health/ops status. */
export interface CryptoStatus {
  source: CryptoKeySource;
  /** sha256(dataKey)[0..8] hex; identifies the key without revealing it. */
  keyId: string;
}

/**
 * Encrypts/decrypts sensitive values at rest using AES-256-GCM. The 32-byte
 * data key never leaves the process and the database only stores ciphertext
 * (see crypto.util.ts for the format).
 *
 * Key source at startup (Phase 4, feature-flagged):
 *   - ENCRYPTION_KEY_WRAPPED set  -> KMS Decrypt into memory (source "kms").
 *   - otherwise                   -> ENCRYPTION_KEY as before (source "env").
 * When both are set the wrapped one wins and a warning asks for the plaintext
 * to be removed. If the unwrap fails: with CRYPTO_STRICT_STARTUP (default
 * true in production) the API refuses to start; otherwise it falls back to the
 * plaintext key when present. With no usable key at all it always refuses.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key: Buffer | null = null;
  private source: CryptoKeySource = 'env';

  constructor(private readonly config: ConfigService) {}

  /**
   * Resolve the data key before the app starts serving. In env mode this is
   * synchronous (the key is set before the first await), so callers that do
   * not await it, like older specs, still get a ready key.
   */
  async onModuleInit(): Promise<void> {
    const wrapped = this.config.get<string>('ENCRYPTION_KEY_WRAPPED')?.trim();
    const plain = this.config.get<string>('ENCRYPTION_KEY')?.trim();

    if (!wrapped) {
      this.useEnvKey(plain);
      return;
    }

    if (plain) {
      this.logger.warn(
        'Both ENCRYPTION_KEY_WRAPPED and ENCRYPTION_KEY are set; the wrapped key is used. Remove the plaintext ENCRYPTION_KEY once the KMS envelope is verified.',
      );
    }

    try {
      this.key = await unwrapDataKey(wrapped, {
        region: this.config.get<string>('AWS_REGION'),
        keyId: this.config.get<string>('KMS_KEY_ID'),
      });
      this.source = 'kms';
      this.logger.log(
        `Encryption key unwrapped via KMS (AES-256-GCM, key id ${keyIdOf(this.key)}).`,
      );
    } catch (err) {
      // Only the error class is logged: KMS messages can echo ARNs/accounts.
      const reason = err instanceof Error ? err.name : 'Error';
      if (this.strictStartup()) {
        this.logger.error(
          `KMS unwrap of ENCRYPTION_KEY_WRAPPED failed (${reason}) and CRYPTO_STRICT_STARTUP is on: refusing to start. Check AWS_REGION, credentials, KMS_KEY_ID and the key policy, or restore ENCRYPTION_KEY to roll back.`,
        );
        throw new Error('Encryption key unavailable: KMS unwrap failed');
      }
      if (!plain) {
        this.logger.error(
          `KMS unwrap of ENCRYPTION_KEY_WRAPPED failed (${reason}) and no ENCRYPTION_KEY fallback is set: refusing to start.`,
        );
        throw new Error('Encryption key unavailable: KMS unwrap failed');
      }
      this.logger.warn(
        `KMS unwrap of ENCRYPTION_KEY_WRAPPED failed (${reason}); falling back to the plaintext ENCRYPTION_KEY because CRYPTO_STRICT_STARTUP is off.`,
      );
      this.useEnvKey(plain);
    }
  }

  private useEnvKey(plain: string | undefined): void {
    this.key = loadKey(plain);
    this.source = 'env';
    this.logger.log(
      `Encryption key loaded from ENCRYPTION_KEY (AES-256-GCM, key id ${keyIdOf(this.key)}).`,
    );
  }

  /** CRYPTO_STRICT_STARTUP; defaults to true in production, false elsewhere. */
  private strictStartup(): boolean {
    const raw = this.config
      .get<string>('CRYPTO_STRICT_STARTUP')
      ?.trim()
      .toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  private getKey(): Buffer {
    if (!this.key) {
      // Lazy env-only fallback for callers that never ran onModuleInit
      // (unit tests). A wrapped key is never resolved lazily.
      if (this.config.get<string>('ENCRYPTION_KEY_WRAPPED')?.trim()) {
        throw new Error(
          'Encryption key not initialised: onModuleInit has not completed',
        );
      }
      this.key = loadKey(this.config.get<string>('ENCRYPTION_KEY'));
    }
    return this.key;
  }

  /** Non-secret facts about the active key (for /admin/ops/status). */
  describe(): CryptoStatus {
    return { source: this.source, keyId: keyIdOf(this.getKey()) };
  }

  /** Encrypt a secret for storage. Returns null/undefined inputs unchanged. */
  encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext == null || plaintext === '') return null;
    return encryptValue(plaintext, this.getKey());
  }

  /**
   * Decrypt a stored secret. Legacy plaintext values (written before encryption
   * was enabled) pass through unchanged, easing the migration.
   */
  decrypt(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    return decryptValue(value, this.getKey());
  }

  /** Whether a stored value is already in encrypted form (v1: or v2:). */
  isEncrypted(value: string | null | undefined): boolean {
    return isEncrypted(value);
  }
}
