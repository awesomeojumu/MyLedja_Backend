import { Module } from "@nestjs/common";
import { loadConfig } from "@/config/env";
import { AuthModule } from "@/modules/auth/auth.module";
import { UsersModule } from "@/modules/users/users.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { CompleteLink } from "@/modules/bank-integrations/application/complete-link";
import { ResolveLinkWorkspace } from "@/modules/bank-integrations/application/resolve-link-workspace";
import { StartLink } from "@/modules/bank-integrations/application/start-link";
import { BankIntegrationsController } from "@/modules/bank-integrations/controllers/bank-integrations.controller";
import { MONO_FETCH, MonoClient } from "@/modules/bank-integrations/domain/mono-client";
import { BankConnectionsRepository } from "@/modules/bank-integrations/repositories/bank-connections.repository";

@Module({
  imports: [AuthModule, UsersModule, WorkspacesModule],
  controllers: [BankIntegrationsController],
  providers: [
    BankConnectionsRepository,
    ResolveLinkWorkspace,
    StartLink,
    CompleteLink,
    {
      provide: MONO_FETCH,
      useValue: globalThis.fetch.bind(globalThis),
    },
    {
      provide: MonoClient,
      inject: [MONO_FETCH],
      useFactory: (fetchImpl: typeof fetch): MonoClient => new MonoClient(loadConfig().monoSecKey, fetchImpl),
    },
  ],
})
export class BankIntegrationsModule {}
