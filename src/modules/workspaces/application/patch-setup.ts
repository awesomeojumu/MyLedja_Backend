import { Injectable } from "@nestjs/common";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { type SetupPatchFields } from "@/modules/workspaces/application/read-setup-patch";
import { DEFAULT_REMINDERS, EMPTY_SETUP, SetupProgress } from "@/modules/workspaces/schemas/workspace";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";

@Injectable()
export class PatchSetup {
  constructor(
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(
    userId: string,
    workspaceId: string,
    input: SetupPatchFields & { setupProgress?: Partial<SetupProgress> },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "update_workspace");
    const current = await this.workspaces.findById(workspaceId);
    const setupProgress = { ...(current?.setupProgress ?? EMPTY_SETUP), ...input.setupProgress };
    const reminders = input.reminders ?? current?.reminders ?? DEFAULT_REMINDERS;
    await this.workspaces.patchSetup(workspaceId, {
      ...(input.defaultCurrency ? { defaultCurrency: input.defaultCurrency } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.weekStartsOn ? { weekStartsOn: input.weekStartsOn } : {}),
      ...(input.reminders ? { reminders: input.reminders } : {}),
      setupProgress,
    });
    return {
      status: "ok" as const,
      data: {
        id: workspaceId,
        defaultCurrency: input.defaultCurrency ?? current?.defaultCurrency ?? "NGN",
        locale: input.locale ?? current?.locale ?? "en-NG",
        timezone: input.timezone ?? current?.timezone ?? "Africa/Lagos",
        weekStartsOn: input.weekStartsOn ?? current?.weekStartsOn ?? "monday",
        reminders,
        setupProgress,
      },
      error: null,
    };
  }
}
