import { isEmail, normalizeEmail } from "@/modules/users/domain/email";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import { isSixDigitCode } from "@/modules/auth/domain/email-code";
import { passwordError } from "@/modules/auth/domain/password";

export interface RecoveryRequestInput {
  email: string;
}

export interface RecoveryConfirmInput {
  email: string;
  code: string;
  password: string;
}

export function parseRecoveryRequest(body: unknown): RecoveryRequestInput {
  if (!body || typeof body !== "object") {
    throw new AuthFailure("bad_request", "email is required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.email !== "string") {
    throw new AuthFailure("bad_request", "email is required");
  }
  const email = normalizeEmail(record.email);
  if (!isEmail(email)) {
    throw new AuthFailure("bad_request", "email is invalid");
  }
  return { email };
}

export function parseRecoveryConfirm(body: unknown): RecoveryConfirmInput {
  const { email } = parseRecoveryRequest(body);
  const record = body as Record<string, unknown>;
  if (typeof record.code !== "string" || !isSixDigitCode(record.code)) {
    throw new AuthFailure("bad_request", "code must be 6 digits");
  }
  if (typeof record.password !== "string") {
    throw new AuthFailure("bad_request", "password is required");
  }
  const problem = passwordError(record.password, email);
  if (problem) {
    throw new AuthFailure("bad_request", problem);
  }
  return { email, code: record.code, password: record.password };
}
