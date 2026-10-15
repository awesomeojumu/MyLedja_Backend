export const APP_ENVS = [
  "development",
  "staging",
  "production",
  "test",
] as const;

export type AppEnv = (typeof APP_ENVS)[number];

export interface AppConfig {
  appEnv: AppEnv;
  port: number;
  appUrl: string;
  jwtSecret: string;
}

function isAppEnv(value: string): value is AppEnv {
  return (APP_ENVS as readonly string[]).includes(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawEnv = env.APP_ENV ?? "development";
  if (!isAppEnv(rawEnv)) {
    throw new Error(`Invalid APP_ENV: ${rawEnv}`);
  }

  const jwtSecret = env.JWT_SECRET ?? "";
  if (rawEnv === "production" && jwtSecret.length < 32) {
    throw new Error("JWT_SECRET is required in production");
  }

  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    appEnv: rawEnv,
    port,
    appUrl: env.APP_URL ?? "http://localhost:4000",
    jwtSecret,
  };
}
