import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { GoalsController } from "@/modules/plans-goals/goals.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [GoalsController],
})
export class PlansGoalsModule {}
