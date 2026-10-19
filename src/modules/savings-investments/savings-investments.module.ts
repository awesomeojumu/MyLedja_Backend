import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { HoldingsController } from "@/modules/savings-investments/holdings.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [HoldingsController],
})
export class SavingsInvestmentsModule {}
