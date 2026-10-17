import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { DashboardController } from "@/modules/dashboard/dashboard.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
