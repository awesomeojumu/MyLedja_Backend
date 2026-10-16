import { Collection, Db, MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectMongo } from "./connect";
import { runInTransaction } from "./transaction";

interface AccountDoc {
  _id: string;
  balanceMinor: bigint;
  currency: "NGN";
}

interface EntryDoc {
  _id: string;
  accountId: string;
  amountMinor: bigint;
}

// MONGODB_TEST_URI runs this against a real cluster (e.g. Atlas dev); otherwise an in-memory replica set.
jest.setTimeout(120_000);

describe("runInTransaction (multi-document)", () => {
  let replSet: MongoMemoryReplSet | undefined;
  let client: MongoClient;
  let db: Db;
  let accounts: Collection<AccountDoc>;
  let entries: Collection<EntryDoc>;

  beforeAll(async () => {
    let uri = process.env.MONGODB_TEST_URI;
    if (!uri) {
      replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      uri = replSet.getUri();
    }
    client = await connectMongo(uri);
    db = client.db(`myledja_test_${Date.now()}`);
    accounts = db.collection<AccountDoc>("accounts");
    entries = db.collection<EntryDoc>("entries");
    await db.createCollection("accounts");
    await db.createCollection("entries");
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await accounts.deleteMany({});
    await entries.deleteMany({});
    await accounts.insertMany([
      { _id: "wallet", balanceMinor: 10_000n, currency: "NGN" },
      { _id: "bank", balanceMinor: 0n, currency: "NGN" },
    ]);
  });

  async function transfer(amountMinor: bigint, failAfterDebit = false): Promise<void> {
    await runInTransaction(client, async (session) => {
      await accounts.updateOne({ _id: "wallet" }, { $inc: { balanceMinor: -amountMinor } }, { session });
      await entries.insertOne({ _id: "t1-out", accountId: "wallet", amountMinor: -amountMinor }, { session });
      if (failAfterDebit) {
        throw new Error("boom");
      }
      await accounts.updateOne({ _id: "bank" }, { $inc: { balanceMinor: amountMinor } }, { session });
      await entries.insertOne({ _id: "t1-in", accountId: "bank", amountMinor }, { session });
    });
  }

  async function balances(): Promise<Record<string, bigint>> {
    const docs = await accounts.find().toArray();
    return Object.fromEntries(docs.map((d) => [d._id, d.balanceMinor]));
  }

  it("commits every write together", async () => {
    await transfer(2_550n);
    expect(await balances()).toEqual({ wallet: 7_450n, bank: 2_550n });
    expect(await entries.countDocuments()).toBe(2);
  });

  it("rolls back every write when the callback throws", async () => {
    await expect(transfer(2_550n, true)).rejects.toThrow("boom");
    expect(await balances()).toEqual({ wallet: 10_000n, bank: 0n });
    expect(await entries.countDocuments()).toBe(0);
  });

  it("rolls back earlier writes when a later write fails (duplicate key)", async () => {
    await entries.insertOne({ _id: "t1-in", accountId: "bank", amountMinor: 1n });
    await expect(transfer(2_550n)).rejects.toThrow(/duplicate key/);
    expect(await balances()).toEqual({ wallet: 10_000n, bank: 0n });
    expect(await entries.countDocuments()).toBe(1);
  });

  it("hides uncommitted writes from readers outside the session", async () => {
    await runInTransaction(client, async (session) => {
      await accounts.updateOne({ _id: "wallet" }, { $inc: { balanceMinor: -1n } }, { session });
      const outside = await accounts.findOne({ _id: "wallet" });
      expect(outside?.balanceMinor).toBe(10_000n);
    });
    expect((await balances()).wallet).toBe(9_999n);
  });

  it("stores money as int64 and reads it back as bigint", async () => {
    expect(await accounts.countDocuments({ balanceMinor: { $type: "long" } })).toBe(2);
    const wallet = await accounts.findOne({ _id: "wallet" });
    expect(typeof wallet?.balanceMinor).toBe("bigint");
  });

  it("returns the callback result on commit", async () => {
    await expect(runInTransaction(client, async () => "done")).resolves.toBe("done");
  });
});
