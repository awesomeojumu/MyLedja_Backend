import { Module } from "@nestjs/common";
import { AccountsModule } from "@/modules/accounts/accounts.module";
import { AuthModule } from "@/modules/auth/auth.module";
import { TransactionsModule } from "@/modules/transactions/transactions.module";
import { UsersModule } from "@/modules/users/users.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";

@Module({
  imports: [AuthModule, UsersModule, WorkspacesModule, AccountsModule, TransactionsModule],
  providers: [LedgerOpsService],
  exports: [LedgerOpsService],
})
export class LedgerModule {}
