import { setServers } from 'node:dns';
import { type ClientSession, type Db, MongoClient, type TransactionOptions } from 'mongodb';

export const DB = Symbol('DB');

/** The one MongoClient and database handle (TECH-SPEC 5.4). */
export class Database {
  private constructor(
    readonly client: MongoClient,
    readonly db: Db,
  ) {}

  static async connect(uri: string, dbName: string, dnsServers: string[] = []): Promise<Database> {
    // Some networks can't resolve the mongodb+srv record; DNS_SERVERS points the resolver elsewhere.
    if (dnsServers.length > 0) setServers(dnsServers);
    const client = new MongoClient(uri, {
      appName: 'myledja-api',
      ignoreUndefined: true,
      useBigInt64: true,
      retryWrites: true,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    return new Database(client, client.db(dbName));
  }

  /**
   * Runs `fn` in a multi-document transaction, retrying transient errors up to 3 times (build plan B1.3 step 9).
   */
  async transaction<T>(fn: (session: ClientSession) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const session = this.client.startSession();
    try {
      let attempt = 0;
      for (;;) {
        try {
          return await session.withTransaction(fn, {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
            ...options,
          });
        } catch (e) {
          const transient = (e as { hasErrorLabel?: (l: string) => boolean }).hasErrorLabel?.(
            'TransientTransactionError',
          );
          if (!transient || ++attempt >= 3) throw e;
        }
      }
    } finally {
      await session.endSession();
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
