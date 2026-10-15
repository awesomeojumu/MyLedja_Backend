import { loadConfig } from "../../config/env";

export function healthStatus(): { ok: true; env: string } {
  const config = loadConfig();
  return { ok: true, env: config.appEnv };
}
