import { ClientSession, MongoClient } from "mongodb";

/**
 * The one pattern for atomic multi-document writes (ADR-0002). Commits when fn resolves, aborts when it throws,
 * and retries transient errors. Every operation inside fn must pass { session }.
 */
export async function runInTransaction<T>(
  client: MongoClient,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return client.withSession((session) =>
    session.withTransaction(() => fn(session), {
      readConcern: { level: "majority" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    }),
  );
}
