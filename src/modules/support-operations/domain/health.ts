export interface HealthStatus {
  status: "ok" | "error";
  database: "up" | "down";
}

/** Probe result only: no env, host, version or error text, so the endpoint leaks nothing (spec §14.3). */
export async function checkHealth(pingDatabase: () => Promise<unknown>): Promise<HealthStatus> {
  try {
    await pingDatabase();
    return { status: "ok", database: "up" };
  } catch {
    return { status: "error", database: "down" };
  }
}
