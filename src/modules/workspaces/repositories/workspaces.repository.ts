import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { ClientSession, Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { WORKSPACES_COLLECTION, WorkspaceDoc } from "@/modules/workspaces/schemas/workspace";

@Injectable()
export class WorkspacesRepository implements OnModuleInit {
  private readonly col: Collection<WorkspaceDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(WORKSPACES_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ ownerId: 1 });
  }

  async insert(workspace: WorkspaceDoc, session?: ClientSession): Promise<void> {
    await this.col.insertOne(workspace, session ? { session } : undefined);
  }

  async findById(id: string): Promise<WorkspaceDoc | null> {
    return this.col.findOne({ _id: id });
  }

  async findByIds(ids: string[]): Promise<WorkspaceDoc[]> {
    return this.col.find({ _id: { $in: ids } }).toArray();
  }

  async updateName(id: string, name: string): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { name } });
  }

  async patchSetup(
    id: string,
    fields: Partial<Pick<WorkspaceDoc, "defaultCurrency" | "setupProgress">>,
  ): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: fields });
  }
}
