import type { Db, Document } from 'mongodb';

const str = { bsonType: 'string' };
const date = { bsonType: 'date' };
const int = { bsonType: ['int', 'long'] };
const nullable = (t: Document) => ({ bsonType: [...[t.bsonType].flat(), 'null'] });
const uuid = { bsonType: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
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
