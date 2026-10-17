import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { loadConfig } from "@/config/env";

export const VERIFY_CODE_TTL_MS = 10 * 60 * 1000;
export const RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

export function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Keyed with the server secret: a plain hash of a 6-digit code falls to a million guesses, so a leaked
 * email_codes collection must not reveal live codes.
 */
export function hashEmailCode(code: string): string {
  return createHmac("sha256", loadConfig().jwtSecret).update(code).digest("hex");
}

export function codeMatches(storedHash: string, code: string): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashEmailCode(code), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isSixDigitCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Does the same work as a real check so a missing account or code takes the same time. */
export function dummyCodeCheck(code: string): void {
  codeMatches(hashEmailCode("000000"), code);
}
