import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { DebtsController } from "@/modules/debts/debts.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [DebtsController],
})
export class DebtsModule {}
