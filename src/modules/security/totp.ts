import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Time-based one-time codes (RFC 6238): 6 digits, 30-second steps, as authenticator apps use. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, unixSeconds: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / STEP_SECONDS)));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

/** Accepts the code for now, or one step either side, to allow for a phone's clock drifting. */
export function verifyTotp(secret: string, code: string, now: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const t = Math.floor(now.getTime() / 1000);
  return [-STEP_SECONDS, 0, STEP_SECONDS].some((d) =>
    timingSafeEqual(Buffer.from(totpAt(secret, t + d)), Buffer.from(code)),
  );
}

export function otpauthUrl(secret: string, email: string): string {
  const label = encodeURIComponent(`MyLedja:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=MyLedja&digits=6&period=${STEP_SECONDS}`;
}

/** Ten backup codes like "4f7k-2m9q" (DESIGN popup 53). Each works once. */
export function newBackupCodes(): string[] {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => chars[x % chars.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}

export const normaliseBackupCode = (code: string) => code.trim().toLowerCase().replace(/\s+/g, '');
