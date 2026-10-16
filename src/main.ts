import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig, loadEnvFile } from "./config/env";

async function bootstrap(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.port);
}

void bootstrap();
