import { Injectable } from "@nestjs/common";
import { loadConfig } from "../../../config/env";
import { UsersRepository } from "../../users/repositories/users.repository";
import { customerNameFromEmail, linkReference } from "../domain/customer-name";
import { MonoClient } from "../domain/mono-client";
import { MonoFailure } from "../domain/mono-failure";
import { ResolveLinkWorkspace } from "./resolve-link-workspace";

const SANDBOX_REDIRECT = "https://mono.co";

@Injectable()
export class StartLink {
  constructor(
    private readonly users: UsersRepository,
    private readonly workspaces: ResolveLinkWorkspace,
    private readonly mono: MonoClient,
  ) {}

  async execute(userId: string, workspaceId?: string): Promise<{ monoUrl: string }> {
    if (!loadConfig().monoSecKey) {
      throw new MonoFailure("misconfigured", "Bank linking is not set up on this server.");
    }
    const user = await this.users.findById(userId);
    if (!user) {
      throw new MonoFailure("unauthorized", "invalid access token");
    }
    const workspace = await this.workspaces.execute(userId, workspaceId);
    const monoUrl = await this.mono.initiate({
      name: customerNameFromEmail(user.email),
      email: user.email,
      ref: linkReference(workspace),
      redirectUrl: SANDBOX_REDIRECT,
    });
    return { monoUrl };
  }
}
