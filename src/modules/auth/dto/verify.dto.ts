import { isEmail, normalizeEmail } from "../../users/domain/email";
import { AuthFailure } from "../domain/auth-failure";
import { isSixDigitCode } from "../domain/email-code";

export interface VerifyInput {
  email: string;
  code: string;
}

export function parseVerify(body: unknown): VerifyInput {
  if (!body || typeof body !== "object") {
    throw new AuthFailure("bad_request", "email and code are required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.email !== "string" || typeof record.code !== "string") {
    throw new AuthFailure("bad_request", "email and code are required");
  }
  const email = normalizeEmail(record.email);
  if (!isEmail(email)) {
    throw new AuthFailure("bad_request", "email is invalid");
  }
  if (!isSixDigitCode(record.code)) {
    throw new AuthFailure("bad_request", "code must be 6 digits");
  }
  return { email, code: record.code };
}
