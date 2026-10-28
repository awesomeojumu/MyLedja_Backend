import type { Db, Document } from 'mongodb';

const str = { bsonType: 'string' };
const date = { bsonType: 'date' };
const int = { bsonType: ['int', 'long'] };
const nullable = (t: Document) => ({ bsonType: [...[t.bsonType].flat(), 'null'] });
const uuid = { bsonType: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const currency = { bsonType: 'string', pattern: '^[A-Z]{3}$' };
const localDate = { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const roles = { enum: ['owner', 'admin', 'editor', 'viewer'] };

const record = (required: string[], properties: Record<string, Document>, workspaced = true): Document => ({
  bsonType: 'object',
  required: ['_id', ...(workspaced ? ['workspaceId'] : []), 'createdAt', 'updatedAt', 'version', ...required],
  properties: {
    _id: uuid,
    ...(workspaced ? { workspaceId: uuid } : {}),
    createdAt: date,
    updatedAt: date,
    version: int,
    ...properties,
  },
});

/** `$jsonSchema` per collection, mirroring the Zod schemas (TECH-SPEC 5.4). */
export const VALIDATORS: Record<string, Document> = {
  users: record(
    ['email', 'name', 'termsAcceptedAt'],
    {
      email: str,
      name: str,
      passwordHash: nullable(str),
      googleId: nullable(str),
      emailVerifiedAt: nullable(date),
      termsAcceptedAt: date,
      deletedAt: nullable(date),
    },
    false,
  ),
  sessions: {
    bsonType: 'object',
    required: ['_id', 'userId', 'refreshHash', 'kind', 'createdAt', 'lastUsedAt', 'expiresAt'],
    properties: {
      _id: uuid,
      userId: uuid,
      refreshHash: str,
      previousHashes: { bsonType: 'array', items: str },
      kind: { enum: ['token', 'cookie', 'memory'] },
      deviceName: nullable(str),
      createdAt: date,
      lastUsedAt: date,
      expiresAt: date,
      absoluteExpiresAt: nullable(date),
      revokedAt: nullable(date),
      revokedReason: nullable(str),
    },
  },
  codes: {
    bsonType: 'object',
    required: ['_id', 'email', 'purpose', 'hash', 'tries', 'createdAt', 'expiresAt'],
    properties: {
      _id: uuid,
      email: str,
      purpose: { enum: ['sign_up', 'recover'] },
      hash: str,
      tries: int,
      createdAt: date,
      expiresAt: date,
    },
  },
  workspaces: record(['name', 'type', 'currency', 'timeZone', 'budgetStyle', 'setupComplete', 'ownerId'], {
    name: str,
    type: { enum: ['personal'] },
    currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
    timeZone: str,
    weekStart: { enum: ['monday', 'sunday', 'saturday'] },
    budgetStyle: { enum: ['tracking', 'envelope'] },
    setupComplete: { bsonType: 'bool' },
    skippedSteps: { bsonType: 'array', items: int },
    features: { bsonType: 'array', items: str },
    ownerId: uuid,
    setupDraft: { bsonType: ['object', 'null'] },
  }),
  memberships: record(['userId', 'role'], { userId: uuid, role: roles }),
  audit_events: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'at', 'action'],
    properties: {
      _id: uuid,
      workspaceId: uuid,
      at: date,
      userId: nullable(uuid),
      sessionId: nullable(uuid),
      action: str,
      target: { bsonType: ['object', 'null'] },
    },
  },
  counters: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'seq'],
    properties: { _id: str, workspaceId: uuid, seq: int },
  },
  jobs: {
    bsonType: 'object',
    required: ['_id', 'name', 'status', 'runAt', 'attempts', 'maxAttempts', 'createdAt', 'updatedAt'],
    properties: {
      _id: str,
      name: str,
      status: { enum: ['queued', 'running', 'done', 'parked'] },
      runAt: date,
      attempts: int,
      maxAttempts: int,
      leaseOwner: nullable(str),
      leaseUntil: nullable(date),
      lastError: nullable(str),
      repeatEverySeconds: nullable(int),
      createdAt: date,
      updatedAt: date,
    },
  },
  rate_limits: {
    bsonType: 'object',
    required: ['_id', 'count', 'expiresAt'],
    properties: { _id: str, count: int, level: int, lockedUntil: nullable(date), expiresAt: date },
  },
  ledger_accounts: record(['kind', 'name', 'currency', 'onBudget', 'sortOrder'], {
    kind: { enum: ['asset', 'liability', 'income', 'expense', 'equity', 'loss'] },
    name: str,
    currency: currency,
    systemKey: nullable(str),
    categoryId: nullable(uuid),
    accountType: nullable(str),
    institution: nullable(str),
    last4: { bsonType: ['string', 'null'], pattern: '^\\d{4}$' },
    onBudget: { bsonType: 'bool' },
    archivedAt: nullable(date),
    sortOrder: int,
    operationId: nullable(str),
  }),
  category_groups: record(['name', 'kind', 'sortOrder'], {
    name: str,
    kind: { enum: ['income', 'expense'] },
    sortOrder: int,
  }),
  categories: record(['groupId', 'name', 'kind', 'hidden', 'budgetable', 'sortOrder', 'deletedAt'], {
    groupId: uuid,
    name: str,
    kind: { enum: ['income', 'expense'] },
    type: { enum: ['fixed', 'flexible', 'non_monthly', 'savings', null] },
    hidden: { bsonType: 'bool' },
    budgetable: { bsonType: 'bool' },
    system: nullable(str),
    starterKey: nullable(str),
    sortOrder: int,
    deletedAt: nullable(date),
  }),
  tags: record(['name', 'nameKey'], { name: str, nameKey: str }),
  payees: record(['name', 'nameKey', 'aliases', 'aliasKeys', 'mergedInto'], {
    name: str,
    nameKey: str,
    aliases: { bsonType: 'array', items: str },
    aliasKeys: { bsonType: 'array', items: str },
    defaultCategoryId: nullable(uuid),
    mergedInto: nullable(uuid),
  }),
  payee_merges: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'keepId', 'merged', 'at'],
    properties: {
      _id: uuid,
      workspaceId: uuid,
      keepId: uuid,
      merged: { bsonType: 'array' },
      at: date,
      undoneAt: nullable(date),
    },
  },
  transactions: record(['operationId', 'type', 'status', 'date', 'recordedAt', 'lines', 'links'], {
    operationId: str,
    type: str,
    status: { enum: ['posted', 'reversed'] },
    date: localDate,
    recordedAt: date,
    payeeId: nullable(uuid),
    notes: nullable(str),
    tagIds: { bsonType: 'array', items: uuid },
    receiptFileIds: { bsonType: 'array', items: str },
    lines: {
      bsonType: 'array',
      minItems: 2,
      items: {
        bsonType: 'object',
        required: ['ledgerAccountId', 'amountMinor', 'currency'],
        properties: {
          ledgerAccountId: uuid,
          amountMinor: { bsonType: 'long' },
          currency: currency,
          categoryId: nullable(uuid),
        },
      },
    },
    links: { bsonType: 'object' },
    fxRate: { bsonType: ['decimal', 'null'] },
    reconciliationId: nullable(uuid),
    clearedAccountIds: { bsonType: 'array', items: uuid },
    importId: nullable(uuid),
  }),
  account_balances: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'ledgerAccountId', 'currency', 'balanceMinor'],
    properties: {
      _id: str,
      workspaceId: uuid,
      ledgerAccountId: uuid,
      currency: currency,
      balanceMinor: { bsonType: 'long' },
      updatedAt: date,
    },
  },
  period_totals: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'ledgerAccountId', 'currency', 'month', 'debitsMinor', 'creditsMinor', 'count'],
    properties: {
      _id: str,
      workspaceId: uuid,
      ledgerAccountId: uuid,
      currency: currency,
      month: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}$' },
      debitsMinor: { bsonType: 'long', minimum: 0 },
      creditsMinor: { bsonType: 'long', minimum: 0 },
      count: int,
    },
  },
  changes: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'seq', 'collection', 'docId', 'op', 'at'],
    properties: {
      _id: uuid,
      workspaceId: uuid,
      seq: int,
      collection: str,
      docId: str,
      op: { enum: ['upsert', 'tombstone'] },
      at: date,
    },
  },
  balance_checks: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'at', 'ok', 'mismatches'],
    properties: {
      _id: uuid,
      workspaceId: uuid,
      at: date,
      ok: { bsonType: 'bool' },
      mismatches: { bsonType: 'array' },
    },
  },
  idempotency: {
    bsonType: 'object',
    required: ['_id', 'scope', 'operationId', 'route', 'bodyHash', 'state', 'createdAt', 'expiresAt'],
    properties: {
      _id: uuid,
      scope: str,
      operationId: str,
      route: str,
      bodyHash: str,
      state: { enum: ['pending', 'done'] },
      statusCode: nullable(int),
      response: nullable(str),
      createdAt: date,
      expiresAt: date,
    },
  },
};

/** Creates each collection with its validator, or updates the validator if it exists. Safe to run twice. */
export async function installValidators(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, schema] of Object.entries(VALIDATORS)) {
    const options = { validator: { $jsonSchema: schema }, validationAction: 'error', validationLevel: 'strict' };
    if (existing.has(name)) await db.command({ collMod: name, ...options });
    else await db.createCollection(name, options);
  }
}
