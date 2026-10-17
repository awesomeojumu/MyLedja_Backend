import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { ClientSession, Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { WorkspaceRole } from "@/modules/workspaces/domain/roles";
import { MEMBERSHIPS_COLLECTION, MembershipDoc } from "@/modules/workspaces/schemas/membership";

@Injectable()
export class MembershipsRepository implements OnModuleInit {
  private readonly col: Collection<MembershipDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(MEMBERSHIPS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ workspaceId: 1, userId: 1 }, { unique: true });
    await this.col.createIndex({ userId: 1 });
  }

  async insert(membership: MembershipDoc, session?: ClientSession): Promise<void> {
    await this.col.insertOne(membership, session ? { session } : undefined);
  }

  async find(workspaceId: string, userId: string, session?: ClientSession): Promise<MembershipDoc | null> {
    return this.col.findOne({ workspaceId, userId }, session ? { session } : undefined);
  }

  async listForUser(userId: string): Promise<MembershipDoc[]> {
    return this.col.find({ userId }).sort({ createdAt: 1 }).toArray();
  }

  async setRole(workspaceId: string, userId: string, role: WorkspaceRole, session?: ClientSession): Promise<void> {
    await this.col.updateOne({ workspaceId, userId }, { $set: { role } }, session ? { session } : undefined);
  }
}
