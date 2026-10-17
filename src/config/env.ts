import { existsSync } from "node:fs";

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
  mongodbUri: string;
  mongodbDb: string;
  monoSecKey: string;
  monoPublicKey: string;
  monoAppId: string;
  accountNumberKey: string;
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

  const mongodbUri = env.MONGODB_URI ?? "";
  if (rawEnv === "production" && !mongodbUri) {
    throw new Error("MONGODB_URI is required in production");
  }

  const accountNumberKey = env.ACCOUNT_NUMBER_KEY ?? "";
  if ((rawEnv === "production" || rawEnv === "staging") && accountNumberKey.length < 64) {
    throw new Error("ACCOUNT_NUMBER_KEY is required in staging and production");
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
    mongodbUri,
    mongodbDb: env.MONGODB_DB ?? "MyLedja",
    monoSecKey: env.MONO_SEC_KEY ?? "",
    monoPublicKey: env.MONO_PUBLIC_KEY ?? "",
    monoAppId: env.MONO_APP_ID ?? "",
    accountNumberKey,
  };
}

/** Loads .env.<APP_ENV> if present. Variables already set in the process win. */
export function loadEnvFile(appEnv: string = process.env.APP_ENV ?? "development"): void {
  const path = `.env.${appEnv}`;
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
