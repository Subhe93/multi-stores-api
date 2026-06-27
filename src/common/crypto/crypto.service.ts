import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decryptValue,
  encryptValue,
  isEncrypted,
  loadKey,
} from './crypto.util';

/**
 * Encrypts/decrypts sensitive values at rest using AES-256-GCM. The root key is
 * read once from the ENCRYPTION_KEY env var and never leaves the process; the
 * database only ever stores ciphertext. See crypto.util.ts for the format.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  // Validate the key at startup so a bad/missing ENCRYPTION_KEY fails fast.
  onModuleInit(): void {
    this.key = loadKey(this.config.get<string>('ENCRYPTION_KEY'));
    this.logger.log('Encryption key loaded (AES-256-GCM).');
  }

  private getKey(): Buffer {
    if (!this.key) {
      this.key = loadKey(this.config.get<string>('ENCRYPTION_KEY'));
    }
    return this.key;
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

  /** Whether a stored value is already in encrypted form. */
  isEncrypted(value: string | null | undefined): boolean {
    return isEncrypted(value);
  }
}
