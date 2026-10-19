import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export function otpauthUri(email: string, secret: string): string {
  return `otpauth://totp/MyLedja:${encodeURIComponent(email)}?secret=${secret}&issuer=MyLedja&period=30`;
}

function secretBytes(secret: string): Buffer {
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secretBytes(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpOk(secret: string, code: string, now = Date.now()): boolean {
  const unix = Math.floor(now / 1000);
  const clean = code.replace(/\s/g, "");
  return [-1, 0, 1].some((w) => totpAt(secret, unix + w * 30) === clean);
}

export function encryptSecret(plain: string, secretKey: string): string {
  const key = createHash("sha256").update(secretKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(packed: string, secretKey: string): string {
  const [ivB, tagB, encB] = packed.split(".");
  const key = createHash("sha256").update(secretKey).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]).toString("utf8");
}

export function newBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(4).toString("hex"));
}
