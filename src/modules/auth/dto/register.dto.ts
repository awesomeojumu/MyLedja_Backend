import { isEmail, normalizeEmail } from "../../users/domain/email";
import { AuthFailure } from "../domain/auth-failure";
import { passwordError } from "../domain/password";

export interface RegisterInput {
  email: string;
  password: string;
}

export function parseRegister(body: unknown): RegisterInput {
  const { email, password } = readEmailPassword(body);
  const problem = passwordError(password, email);
  if (problem) {
    throw new AuthFailure("bad_request", problem);
  }
  return { email, password };
}

export function readEmailPassword(body: unknown): RegisterInput {
  if (!body || typeof body !== "object") {
    throw new AuthFailure("bad_request", "email and password are required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.email !== "string" || typeof record.password !== "string") {
    throw new AuthFailure("bad_request", "email and password are required");
  }
  const email = normalizeEmail(record.email);
  if (!isEmail(email)) {
    throw new AuthFailure("bad_request", "email is invalid");
  }
  return { email, password: record.password };
}
