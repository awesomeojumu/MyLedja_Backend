import { Module } from "@nestjs/common";
import { loadConfig } from "../../config/env";
import { AuthModule } from "../auth/auth.module";
import { UsersModule } from "../users/users.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { CompleteLink } from "./application/complete-link";
import { ResolveLinkWorkspace } from "./application/resolve-link-workspace";
import { StartLink } from "./application/start-link";
import { BankIntegrationsController } from "./controllers/bank-integrations.controller";
import { MONO_FETCH, MonoClient } from "./domain/mono-client";
import { BankConnectionsRepository } from "./repositories/bank-connections.repository";

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
