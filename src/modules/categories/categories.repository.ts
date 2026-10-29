import type { ClientSession, Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { SystemKey } from '../ledger/ledger.types.js';

type Opts = { session?: ClientSession };
type Meta = { createdAt: Date; updatedAt: Date; version: number };

export type CategoryDoc = Meta & {
  _id: string;
  workspaceId: string;
  groupId: string;
  name: string;
  icon: string | null;
  kind: 'income' | 'expense';
  type: 'fixed' | 'flexible' | 'non_monthly' | 'savings' | null;
  hidden: boolean;
  budgetable: boolean;
  carryOver: boolean;
  essential: boolean;
  system: SystemKey | null;
  /** Starter-set key ("food", "uncategorized"), so seeding and Welcome can find it again. */
  starterKey: string | null;
  sortOrder: number;
  deletedAt: Date | null;
  /** Set on delete: where its transactions went, so Undo can bring them back. */
  deletion: { undoId: string; movedTo: string | null; moves: { from: string; to: string }[] } | null;
};

export type GroupDoc = Meta & {
  _id: string;
  workspaceId: string;
  name: string;
  kind: 'income' | 'expense';
  sortOrder: number;
};

export type TagDoc = Meta & { _id: string; workspaceId: string; name: string; nameKey: string };

export type PayeeDoc = Meta & {
  _id: string;
  workspaceId: string;
  name: string;
  nameKey: string;
  aliases: string[];
  aliasKeys: string[];
  defaultCategoryId: string | null;
  logoFileId: string | null;
  /** Set when merged into another payee; such payees are hidden until the merge is undone. */
  mergedInto: string | null;
};

export type PayeeMergeDoc = {
  _id: string;
  workspaceId: string;
  keepId: string;
  kept: {
    name: string;
    aliases: string[];
    defaultCategoryId: string | null;
    logoFileId: string | null;
  };
  merged: { payeeId: string; eventIds: string[] }[];
  at: Date;
  undoneAt: Date | null;
};

export const keyOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

export class CategoriesRepository extends BaseRepository<CategoryDoc> {
  constructor(db: Db) {
    super(db, 'categories');
  }

  live(ctx: WorkspaceContext, o: Opts = {}) {
    return this.find(ctx, { deletedAt: null }, { ...o, sort: { sortOrder: 1, name: 1 } });
  }

  byId(ctx: WorkspaceContext, id: string, o: Opts = {}) {
    return this.findOne(ctx, { _id: id, deletedAt: null }, o);
  }

  byStarterKey(ctx: WorkspaceContext, starterKey: string, o: Opts = {}) {
    return this.findOne(ctx, { starterKey, deletedAt: null }, o);
  }
}

export class GroupsRepository extends BaseRepository<GroupDoc> {
  constructor(db: Db) {
    super(db, 'category_groups');
  }
}

export class TagsRepository extends BaseRepository<TagDoc> {
  constructor(db: Db) {
    super(db, 'tags');
  }
}

export class PayeesRepository extends BaseRepository<PayeeDoc> {
  constructor(db: Db) {
    super(db, 'payees');
  }
}

export class PayeeMergesRepository extends BaseRepository<PayeeMergeDoc> {
  constructor(db: Db) {
    super(db, 'payee_merges');
  }
}
