import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENCRYPTION_CONFIG } from '../../config/encryption.js';
import { CRYPTO_SALTS, CryptoService } from '../CryptoService.js';

describe('CryptoService', () => {
  let testDirectory: string;
  let keyPath: string;

  beforeEach(async () => {
    testDirectory = await fs.mkdtemp(join(tmpdir(), 'code-ally-crypto-'));
    keyPath = join(testDirectory, '.secret-key');
  });

  afterEach(async () => {
    await fs.rm(testDirectory, { recursive: true, force: true });
  });

  it('encrypts and decrypts with the installation-local key', () => {
    const crypto = new CryptoService({ salt: CRYPTO_SALTS.CONFIG, keyPath });
    expect(crypto.decrypt(crypto.encrypt('secret-value'))).toBe('secret-value');
  });

  it('rejects ciphertext made with the removed username-derived key', () => {
    const iv = randomBytes(ENCRYPTION_CONFIG.IV_LENGTH);
    const legacyMaterial = process.env.USER || process.env.USERNAME || 'ally-default';
    const legacyKey = scryptSync(
      legacyMaterial,
      Buffer.from(CRYPTO_SALTS.CONFIG),
      ENCRYPTION_CONFIG.KEY_LENGTH
    );
    const cipher = createCipheriv(ENCRYPTION_CONFIG.ALGORITHM, legacyKey, iv);
    const ciphertext = cipher.update('legacy-secret', 'utf8', 'hex') + cipher.final('hex');
    const encrypted = [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext].join(
      ENCRYPTION_CONFIG.SEPARATOR
    );

    const crypto = new CryptoService({ salt: CRYPTO_SALTS.CONFIG, keyPath });
    expect(() => crypto.decrypt(encrypted)).toThrow();
  });

  it('rejects a corrupt installation key instead of silently replacing it', async () => {
    await fs.writeFile(keyPath, 'not-a-valid-key', { mode: 0o600 });
    const crypto = new CryptoService({ salt: CRYPTO_SALTS.CONFIG, keyPath });

    expect(() => crypto.encrypt('secret-value')).toThrow('Invalid installation encryption key');
  });
});
