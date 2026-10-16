import { INestApplication } from "@nestjs/common";

/** Shared by main.ts and the e2e harness so tests hit the same routes as production. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("v1", { exclude: ["health"] });
  app.enableShutdownHooks();
}
