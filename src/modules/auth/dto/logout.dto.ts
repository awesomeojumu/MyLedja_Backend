import { parseRefresh, RefreshInput } from "./refresh.dto";

export type LogoutInput = RefreshInput;

export function parseLogout(body: unknown): LogoutInput {
  return parseRefresh(body);
}
