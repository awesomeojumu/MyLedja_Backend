import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { ClientSession, Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { OPERATIONS_COLLECTION, OperationDoc } from "@/modules/transactions/schemas/transaction";

@Injectable()
export class OperationsRepository implements OnModuleInit {
  private readonly col: Collection<OperationDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(OPERATIONS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ operationId: 1 }, { unique: true });
  }

  async find(operationId: string): Promise<OperationDoc | null> {
    return this.col.findOne({ operationId });
  }

  async insert(doc: OperationDoc, session?: ClientSession): Promise<void> {
    await this.col.insertOne(doc, session ? { session } : undefined);
  }
}
