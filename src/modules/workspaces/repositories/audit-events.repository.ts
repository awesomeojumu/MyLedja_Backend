import { Inject, Injectable } from "@nestjs/common";
import { ClientSession, Collection, Db } from "mongodb";
import { MONGO_DB } from "../../../database/mongo/mongo.constants";
import { AUDIT_EVENTS_COLLECTION, AuditEventDoc } from "../schemas/audit-event";

@Injectable()
export class AuditEventsRepository {
  private readonly col: Collection<AuditEventDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(AUDIT_EVENTS_COLLECTION);
  }

  async insert(event: AuditEventDoc, session?: ClientSession): Promise<void> {
    await this.col.insertOne(event, session ? { session } : undefined);
  }

  async listForWorkspace(workspaceId: string): Promise<AuditEventDoc[]> {
    return this.col.find({ workspaceId }).toArray();
  }
}
