import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, PageQuery, Uuid } from '../../common/http/schemas.js';
import { SYSTEM_KEYS } from '../ledger/ledger.types.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const CATEGORY_TYPES = ['fixed', 'flexible', 'non_monthly', 'savings'] as const;

const Name = (what: string) =>
  z
    .string()
    .trim()
    .min(1, { error: `Add a name for this ${what}` })
    .max(60, { error: 'Use 60 characters or fewer' });

export const Category = z
  .object({
    id: z.string(),
    groupId: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
    kind: z.enum(['income', 'expense']),
    type: z.enum(CATEGORY_TYPES).nullable().meta({ description: 'Spending categories only.' }),
    hidden: z.boolean().meta({ description: '"Hide from budget".' }),
    budgetable: z.boolean().meta({ description: 'Income: "Count in budget" (TECH-SPEC 6.6).' }),
    carryOver: z.boolean().meta({ description: 'Spending limits style: carry what is left into next month.' }),
    essential: z.boolean(),
    system: z
      .enum(SYSTEM_KEYS)
      .nullable()
      .meta({ description: 'Set for Interest and charges, Fees, Taxes and the like. They cannot be deleted.' }),
    starterKey: z.string().nullable(),
    sortOrder: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'Category' });

export const CategoryGroup = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['income', 'expense']),
    sortOrder: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'CategoryGroup' });

export const CategoryTree = z
  .object({ groups: z.array(CategoryGroup), categories: z.array(Category) })
  .meta({ id: 'CategoryTree' });

export const CategoryParams = WorkspaceParams.extend({ categoryId: Uuid });
export const GroupParams = WorkspaceParams.extend({ groupId: Uuid });

export const CreateCategoryBody = z.object({
  id: Uuid.optional(),
  groupId: Uuid,
  name: Name('category'),
  icon: z.string().max(40).nullable().optional(),
  type: z.enum(CATEGORY_TYPES).nullable().optional(),
  budgetable: z.boolean().optional(),
  carryOver: z.boolean().optional(),
  essential: z.boolean().optional(),
});

export const UpdateCategoryBody = z.object({
  baseVersion: BaseVersion,
  groupId: Uuid.optional(),
  name: Name('category').optional(),
  icon: z.string().max(40).nullable().optional(),
  type: z.enum(CATEGORY_TYPES).nullable().optional(),
  hidden: z.boolean().optional(),
  budgetable: z.boolean().optional(),
  carryOver: z.boolean().optional(),
  essential: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const DeleteCategoryBody = z.object({
  moveTo: Uuid.nullable().meta({
    description: 'Where its transactions move (each one as a correction). Required when it has any.',
  }),
  /** Device-minted undo token (offline toast). When set, the server stores and returns this id. */
  undoId: Uuid.optional(),
});

export const CategoryDeleted = z
  .object({ categoryId: z.string(), moved: z.number().int(), undoId: z.string() })
  .meta({ id: 'CategoryDeleted' });

export const CreateGroupBody = z.object({
  id: Uuid.optional(),
  name: Name('group'),
  kind: z.enum(['income', 'expense']),
});
export const UpdateGroupBody = z.object({
  baseVersion: BaseVersion,
  name: Name('group').optional(),
  sortOrder: z.number().int().optional(),
});

export const Tag = z.object({ id: z.string(), name: z.string(), version: z.number().int() }).meta({ id: 'Tag' });
export const TagParams = WorkspaceParams.extend({ tagId: Uuid });

export const Payee = z
  .object({
    id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()).meta({ description: '"Also appears as": raw bank names that map here.' }),
    defaultCategoryId: z.string().nullable(),
    logoUrl: z.string().nullable(),
    transactionCount: z.number().int(),
    spentThisYear: z.string().meta({ description: 'Minor units.' }),
    lastUsed: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Payee' });

export const PayeePage = z
  .object({ items: z.array(Payee), nextCursor: z.string().nullable() })
  .meta({ id: 'PayeePage' });
export const PayeeParams = WorkspaceParams.extend({ payeeId: Uuid });

const Alias = z.string().trim().min(1).max(120);

export const CreatePayeeBody = z.object({
  id: Uuid.optional(),
  name: Name('payee').max(100),
  aliases: z.array(Alias).max(50).optional(),
  defaultCategoryId: Uuid.nullable().optional(),
});

export const UpdatePayeeBody = z.object({
  baseVersion: BaseVersion,
  name: Name('payee').max(100).optional(),
  aliases: z.array(Alias).max(50).optional(),
  defaultCategoryId: Uuid.nullable().optional(),
});

export const MergePayeesBody = z.object({
  keepId: Uuid,
  mergeIds: z.array(Uuid).min(1, { error: 'Pick at least two payees' }).max(50),
  name: Name('payee').max(100).optional(),
});

export const PayeesMerged = z
  .object({ payee: Payee, moved: z.number().int(), mergeId: z.string() })
  .meta({ id: 'PayeesMerged' });

export const MergeParams = WorkspaceParams.extend({ mergeId: Uuid });
export const UndoParams = WorkspaceParams.extend({ undoId: Uuid });

const tag = 'Categories, tags and payees';
const ws = '/v1/workspaces/:workspaceId';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const categoryRoutes = {
  list: defineRoute({
    name: 'listCategories',
    method: 'GET',
    path: `${ws}/categories`,
    tag,
    summary: 'Groups and categories',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: CategoryTree,
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createCategory',
    method: 'POST',
    path: `${ws}/categories`,
    tag,
    summary: 'Add a category',
    description: 'Its kind (income or spending) follows its group.',
    access: editor,
    params: WorkspaceParams,
    body: CreateCategoryBody,
    status: 201,
    response: Category,
    errors: [400, 401, 403, 404, 409],
  }),
  update: defineRoute({
    name: 'updateCategory',
    method: 'PATCH',
    path: `${ws}/categories/:categoryId`,
    tag,
    summary: 'Rename, move, retype or hide a category',
    access: editor,
    params: CategoryParams,
    body: UpdateCategoryBody,
    status: 200,
    response: Category,
    errors: [400, 401, 403, 404, 409],
  }),
  remove: defineRoute({
    name: 'deleteCategory',
    method: 'POST',
    path: `${ws}/categories/:categoryId/delete`,
    tag,
    summary: 'Delete a category, moving its transactions first',
    description:
      'Moves every transaction (as corrections) and budget amount to `moveTo`, then removes the category. Undo with the returned `undoId`.',
    access: editor,
    params: CategoryParams,
    body: DeleteCategoryBody,
    status: 200,
    response: CategoryDeleted,
    errors: [400, 401, 403, 404, 409],
  }),
  undoRemove: defineRoute({
    name: 'undoDeleteCategory',
    method: 'POST',
    path: `${ws}/categories/undo/:undoId`,
    tag,
    summary: 'Undo a category delete',
    description: 'Restores the category and moves its transactions back.',
    access: editor,
    params: UndoParams,
    status: 200,
    response: Category,
    errors: [400, 401, 403, 404, 409],
  }),
  createGroup: defineRoute({
    name: 'createCategoryGroup',
    method: 'POST',
    path: `${ws}/category-groups`,
    tag,
    summary: 'Add a group',
    access: editor,
    params: WorkspaceParams,
    body: CreateGroupBody,
    status: 201,
    response: CategoryGroup,
    errors: [400, 401, 403, 404, 409],
  }),
  updateGroup: defineRoute({
    name: 'updateCategoryGroup',
    method: 'PATCH',
    path: `${ws}/category-groups/:groupId`,
    tag,
    summary: 'Rename or reorder a group',
    access: editor,
    params: GroupParams,
    body: UpdateGroupBody,
    status: 200,
    response: CategoryGroup,
    errors: [400, 401, 403, 404, 409],
  }),
  removeGroup: defineRoute({
    name: 'deleteCategoryGroup',
    method: 'DELETE',
    path: `${ws}/category-groups/:groupId`,
    tag,
    summary: 'Delete an empty group',
    access: editor,
    params: GroupParams,
    status: 204,
    response: null,
    errors: [400, 401, 403, 404, 409],
  }),
};

export const tagRoutes = {
  list: defineRoute({
    name: 'listTags',
    method: 'GET',
    path: `${ws}/tags`,
    tag,
    summary: 'Every tag',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({ tags: z.array(Tag) }).meta({ id: 'TagList' }),
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createTag',
    method: 'POST',
    path: `${ws}/tags`,
    tag,
    summary: 'Add a tag',
    access: editor,
    params: WorkspaceParams,
    body: z.object({ id: Uuid.optional(), name: Name('tag').max(40) }),
    status: 201,
    response: Tag,
    errors: [400, 401, 403, 404, 409],
  }),
  update: defineRoute({
    name: 'updateTag',
    method: 'PATCH',
    path: `${ws}/tags/:tagId`,
    tag,
    summary: 'Rename a tag',
    access: editor,
    params: TagParams,
    body: z.object({ baseVersion: BaseVersion, name: Name('tag').max(40) }),
    status: 200,
    response: Tag,
    errors: [400, 401, 403, 404, 409],
  }),
  remove: defineRoute({
    name: 'deleteTag',
    method: 'DELETE',
    path: `${ws}/tags/:tagId`,
    tag,
    summary: 'Delete a tag and take it off every transaction',
    access: editor,
    params: TagParams,
    status: 204,
    response: null,
    errors: [400, 401, 403, 404],
  }),
};

export const payeeRoutes = {
  list: defineRoute({
    name: 'listPayees',
    method: 'GET',
    path: `${ws}/payees`,
    tag,
    summary: 'Payees with their usage',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({ q: z.string().max(100).optional(), ...PageQuery }),
    status: 200,
    response: PayeePage,
    errors: [400, 401, 404],
  }),
  get: defineRoute({
    name: 'getPayee',
    method: 'GET',
    path: `${ws}/payees/:payeeId`,
    tag,
    summary: 'One payee',
    access: viewer,
    params: PayeeParams,
    status: 200,
    response: Payee,
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createPayee',
    method: 'POST',
    path: `${ws}/payees`,
    tag,
    summary: 'Add a payee',
    access: editor,
    params: WorkspaceParams,
    body: CreatePayeeBody,
    status: 201,
    response: Payee,
    errors: [400, 401, 403, 404, 409],
  }),
  update: defineRoute({
    name: 'updatePayee',
    method: 'PATCH',
    path: `${ws}/payees/:payeeId`,
    tag,
    summary: 'Rename a payee, its aliases or default category',
    access: editor,
    params: PayeeParams,
    body: UpdatePayeeBody,
    status: 200,
    response: Payee,
    errors: [400, 401, 403, 404, 409],
  }),
  merge: defineRoute({
    name: 'mergePayees',
    method: 'POST',
    path: `${ws}/payees/merge`,
    tag,
    summary: 'Merge payees into one',
    description:
      'Every transaction moves to the kept payee (payee changes in place, TECH-SPEC 6.3), and the merged names become its aliases. Undo with `mergeId`.',
    access: editor,
    params: WorkspaceParams,
    body: MergePayeesBody,
    status: 200,
    response: PayeesMerged,
    errors: [400, 401, 403, 404, 409],
  }),
  undoMerge: defineRoute({
    name: 'undoMergePayees',
    method: 'POST',
    path: `${ws}/payees/merges/:mergeId/undo`,
    tag,
    summary: 'Undo a merge',
    access: editor,
    params: MergeParams,
    status: 200,
    response: z.object({ payees: z.array(Payee) }).meta({ id: 'PayeesRestored' }),
    errors: [400, 401, 403, 404, 409],
  }),
};
