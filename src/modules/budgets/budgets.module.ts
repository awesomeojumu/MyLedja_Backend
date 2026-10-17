import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { BudgetsController } from "@/modules/budgets/budgets.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [BudgetsController],
})
export class BudgetsModule {}
