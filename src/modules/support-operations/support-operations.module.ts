import { Module } from "@nestjs/common";
import { HealthController } from "@/modules/support-operations/controllers/health.controller";

@Module({
  controllers: [HealthController],
})
export class SupportOperationsModule {}
