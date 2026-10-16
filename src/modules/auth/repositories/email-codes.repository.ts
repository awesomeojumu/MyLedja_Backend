import { Inject, Injectable } from "@nestjs/common";
import { ClientSession, Collection, Db } from "mongodb";
import { MONGO_DB } from "../../../database/mongo/mongo.constants";
import { EMAIL_CODES_COLLECTION, EmailCodeDoc, EmailCodePurpose } from "../schemas/email-code";

@Injectable()
export class EmailCodesRepository {
  private readonly col: Collection<EmailCodeDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(EMAIL_CODES_COLLECTION);
  }

  async replaceActive(code: EmailCodeDoc): Promise<void> {
    await this.col.updateMany(
      { email: code.email, purpose: code.purpose, usedAt: null },
      { $set: { usedAt: code.createdAt } },
    );
    await this.col.insertOne(code);
  }

  async findActive(email: string, purpose: EmailCodePurpose): Promise<EmailCodeDoc | null> {
    return this.col.findOne({ email, purpose, usedAt: null });
  }

  async recordMiss(id: string, attempts: number, usedAt: Date | null): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { attempts, usedAt } });
  }

  async consume(id: string, at: Date, session?: ClientSession): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { usedAt: at } }, session ? { session } : undefined);
  }
}
