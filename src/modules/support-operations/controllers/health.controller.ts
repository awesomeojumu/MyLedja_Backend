import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { checkHealth, HealthStatus } from "@/modules/support-operations/domain/health";

@Controller("health")
export class HealthController {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  @Get()
  async status(): Promise<HealthStatus> {
    const health = await checkHealth(() => this.db.command({ ping: 1 }));
    if (health.status !== "ok") {
      throw new ServiceUnavailableException(health);
    }
    return health;
  }
}
