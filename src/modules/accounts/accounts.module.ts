import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { ArchiveAccount } from "@/modules/accounts/application/archive-account";
import { CreateAccount } from "@/modules/accounts/application/create-account";
import { ListAccounts } from "@/modules/accounts/application/list-accounts";
import { SetOpening } from "@/modules/accounts/application/set-opening";
import { AccountsController } from "@/modules/accounts/controllers/accounts.controller";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [AccountsController],
  providers: [AccountsRepository, CreateAccount, ListAccounts, ArchiveAccount, SetOpening],
  exports: [AccountsRepository],
})
export class AccountsModule {}
