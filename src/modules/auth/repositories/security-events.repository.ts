import { Inject, Injectable } from "@nestjs/common";
import { Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { SECURITY_EVENTS_COLLECTION, SecurityEventDoc } from "@/modules/auth/schemas/security-event";

@Injectable()
export class SecurityEventsRepository {
  private readonly col: Collection<SecurityEventDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(SECURITY_EVENTS_COLLECTION);
  }

  async insert(event: SecurityEventDoc): Promise<void> {
    await this.col.insertOne(event);
  }
}
