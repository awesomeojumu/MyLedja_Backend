import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { ClientSession, Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { TRANSACTIONS_COLLECTION, TransactionDoc } from "@/modules/transactions/schemas/transaction";

@Injectable()
export class TransactionsRepository implements OnModuleInit {
  private readonly col: Collection<TransactionDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(TRANSACTIONS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ workspaceId: 1, status: 1 });
  }

  async insert(doc: TransactionDoc, session?: ClientSession): Promise<void> {
    await this.col.insertOne(doc, session ? { session } : undefined);
  }

  async findById(workspaceId: string, id: string): Promise<TransactionDoc | null> {
    return this.col.findOne({ _id: id, workspaceId });
  }

  async listPosted(workspaceId: string): Promise<TransactionDoc[]> {
    return this.col.find({ workspaceId, status: "posted" }).toArray();
  }

  async listAll(workspaceId: string): Promise<TransactionDoc[]> {
    return this.col.find({ workspaceId }).toArray();
  }

  async setStatus(workspaceId: string, id: string, status: TransactionDoc["status"], version: number): Promise<void> {
    await this.col.updateOne({ _id: id, workspaceId }, { $set: { status, version } });
  }
}
