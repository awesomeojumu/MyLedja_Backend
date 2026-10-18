import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { ArchiveAccount } from "@/modules/accounts/application/archive-account";
import { CreateAccount } from "@/modules/accounts/application/create-account";
import { GetAccount } from "@/modules/accounts/application/get-account";
import { ListAccounts } from "@/modules/accounts/application/list-accounts";
import { ListReconciliations } from "@/modules/accounts/application/list-reconciliations";
import { RenameAccount } from "@/modules/accounts/application/rename-account";
import { RestoreAccount } from "@/modules/accounts/application/restore-account";
import { SetKind } from "@/modules/accounts/application/set-kind";
import { SetOpening } from "@/modules/accounts/application/set-opening";
import { AccountsController } from "@/modules/accounts/controllers/accounts.controller";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [AccountsController],
  providers: [
    AccountsRepository,
    CreateAccount,
    ListAccounts,
    GetAccount,
    RenameAccount,
    ArchiveAccount,
    RestoreAccount,
    SetOpening,
    SetKind,
    ListReconciliations,
  ],
  exports: [AccountsRepository],
})
export class AccountsModule {}
