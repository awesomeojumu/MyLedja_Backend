import { Injectable } from "@nestjs/common";
import { loadConfig } from "@/config/env";
import { newId } from "@/common/ids";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { MonoClient } from "@/modules/bank-integrations/domain/mono-client";
import { MonoFailure } from "@/modules/bank-integrations/domain/mono-failure";
import { BankConnectionsRepository } from "@/modules/bank-integrations/repositories/bank-connections.repository";
import { ResolveLinkWorkspace } from "@/modules/bank-integrations/application/resolve-link-workspace";

export interface LinkedBank {
  provider: "mono";
  institution: string;
  name: string;
  mask: string;
  balance: number;
  currency: string;
}

@Injectable()
export class CompleteLink {
  constructor(
    private readonly users: UsersRepository,
    private readonly workspaces: ResolveLinkWorkspace,
    private readonly mono: MonoClient,
    private readonly connections: BankConnectionsRepository,
  ) {}

  async execute(userId: string, code: string, workspaceId?: string): Promise<LinkedBank> {
    const config = loadConfig();
    if (!config.monoSecKey) {
      throw new MonoFailure("misconfigured", "Bank linking is not set up on this server.");
    }
    const user = await this.users.findById(userId);
    if (!user) {
      throw new MonoFailure("unauthorized", "invalid access token");
    }
    const workspace = await this.workspaces.execute(userId, workspaceId);
    const monoAccountId = await this.mono.exchange(code);
    const details = await this.mono.account(monoAccountId);
    const existing = await this.connections.findByMonoAccount(workspace, monoAccountId);
    if (!existing) {
      await this.connections.insert({
        _id: newId(),
        workspaceId: workspace,
        userId,
        provider: "mono",
        monoAppId: config.monoAppId,
        monoAccountId,
        institution: details.institution,
        name: details.name,
        mask: details.mask,
        linkedAt: new Date(),
      });
    }
    return {
      provider: "mono",
      institution: details.institution,
      name: details.name,
      mask: details.mask,
      balance: details.balance,
      currency: details.currency,
    };
  }
}
