import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Collection, Db, MongoServerError } from "mongodb";
import { MONGO_DB } from "../../../database/mongo/mongo.constants";
import { BANK_CONNECTIONS_COLLECTION, BankConnectionDoc } from "../schemas/bank-connection";

const DUPLICATE_KEY = 11000;

@Injectable()
export class BankConnectionsRepository implements OnModuleInit {
  private readonly col: Collection<BankConnectionDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(BANK_CONNECTIONS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ workspaceId: 1, monoAccountId: 1 }, { unique: true });
    await this.col.createIndex({ workspaceId: 1, userId: 1 });
  }

  async insert(connection: BankConnectionDoc): Promise<"inserted" | "duplicate"> {
    try {
      await this.col.insertOne(connection);
      return "inserted";
    } catch (error) {
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
        return "duplicate";
      }
      throw error;
    }
  }

  async findByMonoAccount(workspaceId: string, monoAccountId: string): Promise<BankConnectionDoc | null> {
    return this.col.findOne({ workspaceId, monoAccountId });
  }
}
