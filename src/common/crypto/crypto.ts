import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Labels for keys derived from ACCOUNT_NUMBER_KEY, one per use (TECH-SPEC 10). */
export type KeyLabel = 'two-factor' | 'bank-link' | 'backup' | 'idempotency' | 'token-hash' | 'code-hash';

const KEY_VERSION = 'k1';

export class CryptoError extends Error {
  constructor() {
    super('decrypt_failed');
    this.name = 'CryptoError';
  }
}

/**
 * HKDF-SHA256 keys from the root key, and AES-256-GCM values that record the key version that made them,
 * so a later ACCOUNT_NUMBER_KEY_NEXT can re-encrypt without guessing.
 */
export class Crypto {
  private readonly root: Buffer;
  private readonly keys = new Map<KeyLabel, Buffer>();

  constructor(rootKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(rootKeyHex)) throw new Error('ACCOUNT_NUMBER_KEY must be 64 hex characters');
    this.root = Buffer.from(rootKeyHex, 'hex');
  }

  key(label: KeyLabel): Buffer {
    let k = this.keys.get(label);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', this.root, Buffer.from('myledja'), Buffer.from(`myledja:${label}`), 32));
      this.keys.set(label, k);
    }
    return k;
  }

  encrypt(label: KeyLabel, plaintext: string | Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(label), iv);
    cipher.setAAD(Buffer.from(`${KEY_VERSION}:${label}`));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [KEY_VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(label: KeyLabel, value: string): Buffer {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== KEY_VERSION) throw new CryptoError();
    const [, iv, tag, data] = parts as [string, string, string, string];
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(label), Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(`${KEY_VERSION}:${label}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
    } catch {
      throw new CryptoError();
    }
  }

  decryptText(label: KeyLabel, value: string): string {
    return this.decrypt(label, value).toString('utf8');
  }

  /** A keyed hash for secrets we only compare (refresh tokens, email codes), so a database copy can't be reversed. */
  hash(label: 'token-hash' | 'code-hash', value: string): string {
    return createHmac('sha256', this.key(label)).update(value).digest('base64url');
  }

  static equal(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}
