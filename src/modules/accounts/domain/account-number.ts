import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AccountFailure } from "@/modules/accounts/domain/account-failure";

const ALGO = "aes-256-gcm";

export function maskNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : digits;
}

export function encryptAccountNumber(
  raw: string,
  keyHex: string,
): { cipher: string; iv: string; tag: string; mask: string } {
  if (keyHex.length < 64) {
    throw new AccountFailure("bad_request", "Account number encryption is not set up.");
  }
  const key = Buffer.from(keyHex.slice(0, 64), "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return {
    cipher: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    mask: maskNumber(raw),
  };
}

export function decryptAccountNumber(input: { cipher: string; iv: string; tag: string }, keyHex: string): string {
  const key = Buffer.from(keyHex.slice(0, 64), "hex");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(input.cipher, "base64")), decipher.final()]).toString("utf8");
}
