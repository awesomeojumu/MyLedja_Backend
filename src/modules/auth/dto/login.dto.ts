import { RegisterInput, readEmailPassword } from "./register.dto";

export type LoginInput = RegisterInput;

export function parseLogin(body: unknown): LoginInput {
  return readEmailPassword(body);
}
