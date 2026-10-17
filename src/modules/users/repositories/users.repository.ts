import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { ClientSession, Collection, Db, MongoServerError } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { USERS_COLLECTION, UserDoc } from "@/modules/users/schemas/user";

const DUPLICATE_KEY = 11000;

@Injectable()
export class UsersRepository implements OnModuleInit {
  private readonly col: Collection<UserDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(USERS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ email: 1 }, { unique: true });
  }

  async insert(user: UserDoc): Promise<"inserted" | "duplicate"> {
    try {
      await this.col.insertOne(user);
      return "inserted";
    } catch (error) {
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
        return "duplicate";
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.col.findOne({ email });
  }

  async findById(id: string): Promise<UserDoc | null> {
    return this.col.findOne({ _id: id });
  }

  async markVerified(id: string, at: Date, session?: ClientSession): Promise<void> {
    await this.col.updateOne({ _id: id, verifiedAt: null }, { $set: { verifiedAt: at } }, session ? { session } : undefined);
  }

  async setPassword(id: string, passwordHash: string, session?: ClientSession): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { passwordHash } }, session ? { session } : undefined);
  }
}
