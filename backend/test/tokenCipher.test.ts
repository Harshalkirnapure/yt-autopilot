import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENCRYPTED_PREFIX,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  parseEncryptionKey,
} from '../src/utils/tokenCipher.js';

const KEY_HEX = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const OTHER_KEY_HEX = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

const KEY = parseEncryptionKey(KEY_HEX);
const OTHER_KEY = parseEncryptionKey(OTHER_KEY_HEX);

test('a token round-trips and the stored value never contains the plaintext', () => {
  const secret = 'ya29.a0AfB_byC-example-access-token';
  const stored = encryptSecret(secret, KEY);

  assert.ok(stored.startsWith(ENCRYPTED_PREFIX), 'stored value is self-describing');
  assert.ok(isEncrypted(stored));
  assert.ok(!stored.includes(secret), 'the plaintext is not part of the ciphertext');
  assert.equal(decryptSecret(stored, KEY), secret);
});

test('each write uses a fresh IV, so equal tokens encrypt differently', () => {
  const first = encryptSecret('same-refresh-token', KEY);
  const second = encryptSecret('same-refresh-token', KEY);

  assert.notEqual(first, second);
  assert.equal(decryptSecret(first, KEY), 'same-refresh-token');
  assert.equal(decryptSecret(second, KEY), 'same-refresh-token');
});

test('rows written before encryption existed are still read as plaintext', () => {
  assert.equal(isEncrypted('1//0gLegacyRefreshToken'), false);
  assert.equal(decryptSecret('1//0gLegacyRefreshToken', KEY), '1//0gLegacyRefreshToken');
  // Also keyless development, where nothing was ever encrypted.
  assert.equal(decryptSecret('1//0gLegacyRefreshToken', null), '1//0gLegacyRefreshToken');
});

test('a tampered value or a different key is rejected instead of returning garbage', () => {
  const stored = encryptSecret('refresh-token', KEY);
  const tampered = `${stored.slice(0, -2)}${stored.endsWith('AA') ? 'BB' : 'AA'}`;

  assert.notEqual(tampered, stored);
  assert.throws(() => decryptSecret(tampered, KEY), /does not decrypt the stored YouTube tokens/);
  assert.throws(() => decryptSecret(stored, OTHER_KEY), /does not decrypt the stored YouTube tokens/);
});

test('an encrypted value cannot be read without a key', () => {
  const stored = encryptSecret('refresh-token', KEY);
  assert.throws(() => decryptSecret(stored, null), /TOKEN_ENCRYPTION_KEY is not set/);
});

test('without a key, new tokens are written unchanged (development and tests)', () => {
  assert.equal(encryptSecret('dev-access-token', null), 'dev-access-token');
});

test('the key may be 64 hex characters or base64 of 32 bytes', () => {
  const fromHex = parseEncryptionKey(`  ${KEY_HEX}  `);
  const fromBase64 = parseEncryptionKey(KEY.toString('base64'));

  assert.equal(fromHex.length, 32);
  assert.deepEqual(fromBase64, fromHex, 'both encodings produce the same key');

  const stored = encryptSecret('shared', fromBase64);
  assert.equal(decryptSecret(stored, fromHex), 'shared', 'hex and base64 spellings interoperate');
});

test('a key of the wrong size is rejected with the expected format', () => {
  for (const malformed of ['', 'short', 'not-a-key', 'a'.repeat(32), '00'.repeat(16)]) {
    assert.throws(() => parseEncryptionKey(malformed), /TOKEN_ENCRYPTION_KEY must be 32 bytes/);
  }
});
