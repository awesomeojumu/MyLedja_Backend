import { Module } from "@nestjs/common";
import { AccountsModule } from "@/modules/accounts/accounts.module";
import { AuthModule } from "@/modules/auth/auth.module";
import { CategoriesMerchantsModule } from "@/modules/categories-merchants/categories-merchants.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { ChangeStatus } from "@/modules/transactions/application/change-status";
import { CreateTransaction } from "@/modules/transactions/application/create-transaction";
import { TransactionsController } from "@/modules/transactions/controllers/transactions.controller";
import { OperationsRepository } from "@/modules/transactions/repositories/operations.repository";
import { TransactionsRepository } from "@/modules/transactions/repositories/transactions.repository";

@Module({
  imports: [AuthModule, WorkspacesModule, AccountsModule, CategoriesMerchantsModule],
  controllers: [TransactionsController],
  providers: [TransactionsRepository, OperationsRepository, CreateTransaction, ChangeStatus],
  exports: [TransactionsRepository, CreateTransaction],
})
export class TransactionsModule {}
