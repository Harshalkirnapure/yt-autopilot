import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the YouTube OAuth tokens stored in `oauth_tokens`.
 *
 * The key never lives in the database; it comes from `TOKEN_ENCRYPTION_KEY`. Values written by this
 * module are self-describing (`enc:v1:` + base64 of iv|tag|ciphertext), so a row written before
 * encryption existed — or while no key was configured — is still read as plaintext.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const ENCRYPTED_PREFIX = 'enc:v1:';

const KEY_HINT =
  'TOKEN_ENCRYPTION_KEY must be 32 bytes — 64 hex characters or base64 of 32 bytes, ' +
  'for example the output of "openssl rand -base64 32".';

/** A 32-byte key from either 64 hex characters or base64. Throws on anything else. */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === KEY_BYTES) return decoded;

  throw new Error(`Invalid ${KEY_HINT}`);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypts a token. Without a key the value is written as-is: that is the development/test path, and
 * production refuses to start without a key (see `assertTokenEncryptionConfig`).
 */
export function encryptSecret(value: string, key: Buffer | null): string {
  if (!key) return value;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTED_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypts a stored token. A value without the prefix is a pre-encryption (or keyless-development)
 * row and is returned unchanged; that keeps existing plaintext rows readable after the key is added.
 */
export function decryptSecret(stored: string, key: Buffer | null): string {
  if (!isEncrypted(stored)) return stored;

  if (!key) {
    throw new Error(
      'The stored YouTube tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set. ' +
        'Set it to the key the tokens were written with, or reconnect the channel.',
    );
  }

  const payload = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
  if (payload.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('A stored YouTube token is not a valid encrypted value; reconnect the channel.');
  }

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY does not decrypt the stored YouTube tokens. ' +
        'Restore the key they were written with, or reconnect the channel at /api/youtube/auth.',
    );
  }
}
