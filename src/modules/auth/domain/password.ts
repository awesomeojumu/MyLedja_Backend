import { argon2id, hash, verify, type HashOptions } from "argon2";

export const ARGON2_OPTIONS = Symbol("ARGON2_OPTIONS");

export const ARGON2_PRODUCTION = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as HashOptions;

export const ARGON2_TEST = {
  type: argon2id,
  memoryCost: 8,
  timeCost: 1,
  parallelism: 1,
} as HashOptions;

const COMMON_PASSWORDS = new Set([
  "password123",
  "password12",
  "1234567890",
  "qwertyuiop",
  "letmein123",
  "administrator",
  "iloveyou12",
  "welcome123",
  "abcdefghij",
  "1111111111",
]);

export function passwordError(password: string, email: string): string | undefined {
  if (password.length < 10) {
    return "password must be at least 10 characters";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "password is too common";
  }
  if (password.toLowerCase() === email.toLowerCase()) {
    return "password must not match the email";
  }
  return undefined;
}

export async function hashPassword(password: string, options: HashOptions): Promise<string> {
  return hash(password, options);
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    return false;
  }
}

let unusedHash: string | undefined;

export async function unusedPasswordWork(password: string, options: HashOptions): Promise<void> {
  unusedHash ??= await hashPassword("unused-password-not-stored", options);
  await verifyPassword(unusedHash, password);
}
