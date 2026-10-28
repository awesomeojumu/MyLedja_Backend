import type { ClientSession, Db, Document } from 'mongodb';

type Opts = { session?: ClientSession };

/** Every collection that holds a workspace's own data, in the order a restore writes them. */
export const WORKSPACE_DATA = [
  'ledger_accounts',
  'account_balances',
  'period_totals',
  'category_groups',
  'categories',
  'tags',
  'payees',
  'payee_merges',
  'transactions',
  'budget_months',
  'templates',
  'schedules',
  'occurrences',
  'debts',
  'goals',
  'goal_allocations',
  'income_streams',
  'imports',
  'reconciliations',
  'transfer_dismissals',
  'notifications',
  'audit_events',
] as const;

/** Workspace bookkeeping that is rebuilt rather than copied. */
const WORKSPACE_ALSO = ['changes', 'counters', 'memberships', 'balance_checks'] as const;

/**
 * Whole-workspace reads and writes for export, backup, restore and deletion (build plan B3.5 to B3.7).
 * The only code that reaches across collections; every call is scoped to one workspace or one person.
 */
export class ExportsRepository {
  constructor(private readonly db: Db) {}

  async dumpWorkspace(workspaceId: string): Promise<Record<string, Document[]>> {
    const out: Record<string, Document[]> = {};
    for (const name of WORKSPACE_DATA) {
      const docs = await this.db.collection(name).find({ workspaceId }).toArray();
      out[name] = docs.map(({ workspaceId: _w, ...rest }) => rest);
    }
    return out;
  }

  workspaceDoc(workspaceId: string) {
    return this.db.collection('workspaces').findOne({ _id: workspaceId as never });
  }

  async insertWorkspace(workspaceId: string, data: Record<string, Document[]>, o: Opts = {}) {
    for (const name of WORKSPACE_DATA) {
      const docs = data[name] ?? [];
      if (docs.length)
        await this.db.collection(name).insertMany(
          docs.map((d) => ({ ...d, workspaceId })),
          o,
        );
    }
  }

  async insertRaw(name: 'workspaces' | 'memberships' | 'counters', doc: Document, o: Opts = {}) {
    await this.db.collection(name).insertOne(doc, o);
  }

  async deleteWorkspace(workspaceId: string) {
    for (const name of [...WORKSPACE_DATA, ...WORKSPACE_ALSO])
      await this.db.collection(name).deleteMany({ workspaceId });
    await this.db.collection('workspaces').deleteOne({ _id: workspaceId as never });
  }

  /** Workspaces where this person is the only owner: they go with the account. */
  async soleOwnedWorkspaces(userId: string): Promise<string[]> {
    const owned = await this.db.collection('memberships').find({ userId, role: 'owner' }).toArray();
    const out: string[] = [];
    for (const m of owned) {
      const owners = await this.db
        .collection('memberships')
        .countDocuments({ workspaceId: m.workspaceId, role: 'owner' });
      if (owners === 1) out.push(String(m.workspaceId));
    }
    return out;
  }

  async deletePerson(userId: string, email: string) {
    await this.db.collection('memberships').deleteMany({ userId });
    await this.db.collection('sessions').deleteMany({ userId });
    await this.db.collection('codes').deleteMany({ email });
    await this.db.collection('users').deleteOne({ _id: userId as never });
  }

  /** Every collection, for the nightly backup (TECH-SPEC 5.10). */
  async dumpAll(): Promise<Record<string, Document[]>> {
    const out: Record<string, Document[]> = {};
    for (const c of await this.db.listCollections({}, { nameOnly: true }).toArray()) {
      if (c.name.startsWith('system.')) continue;
      out[c.name] = await this.db.collection(c.name).find({}).toArray();
    }
    return out;
  }
}
