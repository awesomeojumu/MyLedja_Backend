import { RegisterInput, readEmailPassword } from "@/modules/auth/dto/register.dto";

export type LoginInput = RegisterInput;

export function parseLogin(body: unknown): LoginInput {
  return readEmailPassword(body);
}
