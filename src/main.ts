import "reflect-metadata";
import { setServers } from "node:dns";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "@/app.module";
import { configureApp } from "@/app.setup";
import { loadConfig, loadEnvFile } from "@/config/env";

async function bootstrap(): Promise<void> {
  loadEnvFile();
  // Optional: some machines point Node's resolver at a dead local DNS, which breaks mongodb+srv lookups.
  const dnsServers = (process.env.DNS_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (dnsServers.length > 0) {
    setServers(dnsServers);
  }
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (process.env.TRUST_PROXY) {
    app.set("trust proxy", process.env.TRUST_PROXY);
  }
  const origins = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (origins.length > 0) {
    app.enableCors({ origin: origins });
  }
  configureApp(app);
  await app.listen(config.port);
}

void bootstrap();
