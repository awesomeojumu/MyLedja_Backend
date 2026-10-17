import { parseRefresh, RefreshInput } from "@/modules/auth/dto/refresh.dto";

export type LogoutInput = RefreshInput;

export function parseLogout(body: unknown): LogoutInput {
  return parseRefresh(body);
}
