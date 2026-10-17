import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { IncomeController } from "@/modules/income/income.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [IncomeController],
})
export class IncomeModule {}
