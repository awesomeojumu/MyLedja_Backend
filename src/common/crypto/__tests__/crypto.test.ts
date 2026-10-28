import { describe, expect, it } from 'vitest';
import { Crypto, CryptoError } from '../crypto.js';

const crypto = new Crypto('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');

describe('crypto (B0.5, TECH-SPEC 10)', () => {
  it('encrypts then decrypts', () => {
    const value = crypto.encrypt('two-factor', 'JBSWY3DPEHPK3PXP');
    expect(value.startsWith('k1.')).toBe(true);
    expect(value).not.toContain('JBSWY3DPEHPK3PXP');
    expect(crypto.decryptText('two-factor', value)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('gives a different ciphertext each time', () => {
    expect(crypto.encrypt('backup', 'same')).not.toBe(crypto.encrypt('backup', 'same'));
  });

  it('refuses a tampered value', () => {
    const value = crypto.encrypt('bank-link', 'token');
    const parts = value.split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = data[0]! ^ 1;
    parts[3] = data.toString('base64url');
    expect(() => crypto.decrypt('bank-link', parts.join('.'))).toThrow(CryptoError);
    expect(() => crypto.decrypt('bank-link', 'k2.a.b.c')).toThrow(CryptoError);
    expect(() => crypto.decrypt('bank-link', 'nonsense')).toThrow(CryptoError);
  });

  it('two labels give different keys, and a value only opens with its own label', () => {
    expect(crypto.key('two-factor').equals(crypto.key('backup'))).toBe(false);
    const value = crypto.encrypt('two-factor', 'secret');
    expect(() => crypto.decrypt('backup', value)).toThrow(CryptoError);
  });

  it('derives the same key for the same root and label', () => {
    const again = new Crypto('00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF');
    expect(again.key('backup').equals(crypto.key('backup'))).toBe(true);
    expect(() => new Crypto('abc')).toThrow();
  });

  it('hashes with a key, and compares in constant time', () => {
    const h = crypto.hash('code-hash', '123456');
    expect(h).toBe(crypto.hash('code-hash', '123456'));
    expect(h).not.toBe(crypto.hash('token-hash', '123456'));
    expect(Crypto.equal(h, crypto.hash('code-hash', '123456'))).toBe(true);
    expect(Crypto.equal(h, 'short')).toBe(false);
  });
});
