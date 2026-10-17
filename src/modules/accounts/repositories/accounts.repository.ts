import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { ClientSession, Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { ACCOUNTS_COLLECTION, AccountDoc } from "@/modules/accounts/schemas/account";

@Injectable()
export class AccountsRepository implements OnModuleInit {
  private readonly col: Collection<AccountDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(ACCOUNTS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ workspaceId: 1 });
  }

  async insert(doc: AccountDoc, session?: ClientSession): Promise<void> {
    await this.col.insertOne(doc, session ? { session } : undefined);
  }

  async findById(workspaceId: string, id: string): Promise<AccountDoc | null> {
    return this.col.findOne({ _id: id, workspaceId });
  }

  async list(workspaceId: string, archived: boolean): Promise<AccountDoc[]> {
    return this.col
      .find({ workspaceId, archivedAt: archived ? { $ne: null } : null })
      .toArray();
  }

  async archive(workspaceId: string, id: string, at: Date): Promise<void> {
    await this.col.updateOne({ _id: id, workspaceId }, { $set: { archivedAt: at } });
  }

  async setOpening(
    workspaceId: string,
    id: string,
    openingBalanceMinor: bigint,
    balanceMinor: bigint,
  ): Promise<void> {
    await this.col.updateOne({ _id: id, workspaceId }, { $set: { openingBalanceMinor, balanceMinor } });
  }

  async addBalance(id: string, delta: bigint, session?: ClientSession): Promise<void> {
    await this.col.updateOne({ _id: id }, { $inc: { balanceMinor: delta } }, session ? { session } : undefined);
  }
}
