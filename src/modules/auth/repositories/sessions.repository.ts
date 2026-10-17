import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { SESSIONS_COLLECTION, SessionDoc } from "@/modules/auth/schemas/session";

@Injectable()
export class SessionsRepository implements OnModuleInit {
  private readonly col: Collection<SessionDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(SESSIONS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.col.createIndex({ refreshTokenHash: 1 }, { unique: true });
    await this.col.createIndex({ familyId: 1 });
    await this.col.createIndex({ userId: 1 });
  }

  async insert(session: SessionDoc): Promise<void> {
    await this.col.insertOne(session);
  }

  async findById(id: string): Promise<SessionDoc | null> {
    return this.col.findOne({ _id: id });
  }

  async findByHash(refreshTokenHash: string): Promise<SessionDoc | null> {
    return this.col.findOne({ refreshTokenHash });
  }

  async findByFamily(familyId: string): Promise<SessionDoc | null> {
    return this.col.findOne({ familyId });
  }

  /**
   * Swaps the refresh token only if the presented one is still current. Two concurrent refreshes with the
   * same token cannot both win; the loser is treated as reuse.
   */
  async rotate(
    id: string,
    currentHash: string,
    nextHash: string,
    lastSeenAt: Date,
    idleExpiresAt: Date,
  ): Promise<boolean> {
    const result = await this.col.updateOne(
      { _id: id, refreshTokenHash: currentHash, revokedAt: null },
      { $set: { refreshTokenHash: nextHash, lastSeenAt, idleExpiresAt } },
    );
    return result.modifiedCount === 1;
  }

  async revokeFamily(familyId: string, at: Date): Promise<void> {
    await this.col.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: at } });
  }

  async revokeUser(userId: string, at: Date): Promise<void> {
    await this.col.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: at } });
  }

  async listByUser(userId: string): Promise<SessionDoc[]> {
    return this.col.find({ userId }).toArray();
  }

  async revokeById(id: string, userId: string, at: Date): Promise<boolean> {
    const result = await this.col.updateOne({ _id: id, userId, revokedAt: null }, { $set: { revokedAt: at } });
    return result.modifiedCount === 1;
  }
}
