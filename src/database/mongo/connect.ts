import { MongoClient } from "mongodb";

/** useBigInt64 returns int64 money fields as bigint (ADR-0001). */
export async function connectMongo(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, {
    appName: "myledja-api",
    useBigInt64: true,
    serverSelectionTimeoutMS: 10_000,
  });
  return client.connect();
}
