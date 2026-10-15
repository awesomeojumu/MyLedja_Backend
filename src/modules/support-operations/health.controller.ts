import { Controller, Get } from "@nestjs/common";
import { healthStatus } from "./health";

@Controller("health")
export class HealthController {
  @Get()
  status(): { ok: true; env: string } {
    return healthStatus();
  }
}
