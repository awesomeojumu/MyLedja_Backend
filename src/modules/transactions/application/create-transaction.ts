import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { MongoClient } from "mongodb";
import { isId, newId } from "@/common/ids";
import { parseMoney } from "@/common/money/money";
import { MONGO_CLIENT } from "@/database/mongo/mongo.constants";
import { runInTransaction } from "@/database/mongo/transaction";
import { Inject } from "@nestjs/common";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import { CatalogRepository } from "@/modules/categories-merchants/repositories/catalog.repository";
import { resolveMerchant } from "@/modules/categories-merchants/domain/aliases";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";
import { LedgerFailure } from "@/modules/transactions/domain/ledger-failure";
import { OperationsRepository } from "@/modules/transactions/repositories/operations.repository";
import { TransactionsRepository } from "@/modules/transactions/repositories/transactions.repository";
import { Effect, LedgerStatus, LedgerType, TransactionDoc } from "@/modules/transactions/schemas/transaction";
import { periodTotals } from "@/modules/transactions/application/totals";
import { publicTransaction } from "@/modules/transactions/application/public-transaction";

export interface CreateTxnInput {
  operationId: string;
  type: LedgerType;
  amount: string;
  currency?: string;
  accountId: string;
  toAccountId?: string;
  categoryId?: string;
  description: string;
  status?: LedgerStatus;
  tagIds?: string[];
  occurredAt?: string;
  originalTransactionId?: string;
}

@Injectable()
export class CreateTransaction {
  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    private readonly txns: TransactionsRepository,
    private readonly operations: OperationsRepository,
    private readonly accounts: AccountsRepository,
    private readonly catalog: CatalogRepository,
    private readonly memberships: ResolveMembership,
    private readonly workspaces: WorkspacesRepository,
  ) {}

  async execute(userId: string, workspaceId: string, input: CreateTxnInput) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    if (!isId(input.operationId)) throw new LedgerFailure("bad_request", "operationId must be a UUIDv7.");
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = await this.operations.find(input.operationId);
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new LedgerFailure("reused", "OPERATION_ID_REUSED");
      }
      const original = await this.txns.findById(workspaceId, existing.entityId);
      if (!original) throw new LedgerFailure("not_found", "not found");
      return {
        status: "ok" as const,
        data: { transaction: publicTransaction(original), totals: periodTotals(await this.txns.listPosted(workspaceId)) },
        error: null,
      };
    }

    const currency = input.currency ?? "NGN";
    const amount = parseMoney(input.amount, currency);
    if (amount.amountMinor <= 0n) throw new LedgerFailure("bad_request", "Enter an amount greater than zero.");
    const status: LedgerStatus = input.status ?? "posted";
    if (!["pending", "posted", "reversed", "voided"].includes(status)) {
      throw new LedgerFailure("bad_request", "Unsupported status.");
    }

    const from = await this.accounts.findById(workspaceId, input.accountId);
    if (!from || from.archivedAt) throw new LedgerFailure("bad_request", "Choose a valid account.");
    if (input.type === "refund") {
      if (!input.originalTransactionId) throw new LedgerFailure("bad_request", "Refund needs the original transaction.");
      const original = await this.txns.findById(workspaceId, input.originalTransactionId);
      if (!original) throw new LedgerFailure("bad_request", "Original transaction not found.");
      if (original.type !== "expense") throw new LedgerFailure("bad_request", "Only an expense can be refunded.");
      const refunded = (await this.txns.listPosted(workspaceId))
        .filter((row) => row.type === "refund" && row.originalTransactionId === original._id)
        .reduce((sum, row) => sum + row.amountMinor, 0n);
      if (refunded + amount.amountMinor > original.amountMinor) {
        throw new LedgerFailure("bad_request", "A refund can’t be more than what’s left of the original expense.");
      }
    }

    let merchantId = undefined as string | undefined;
    const merchants = await this.catalog.merchants.find({ workspaceId }).toArray();
    const matched = resolveMerchant(input.description, merchants);
    if (matched) merchantId = matched._id;

    let categoryId = input.categoryId ?? matched?.categoryId;
    if (input.type === "transfer" || input.type === "allocation" || input.type === "loan_in" || input.type === "loan_out" || input.type === "principal_collect") {
      categoryId = undefined;
    } else if (categoryId) {
      const category = await this.catalog.categories.findOne({ _id: categoryId, workspaceId });
      if (!category) throw new LedgerFailure("bad_request", "Unknown category.");
      if (category.kind === "income" && input.type === "expense") {
        throw new LedgerFailure("unprocessable", "An expense cannot use an income category.");
      }
      if (category.kind === "expense" && (input.type === "income" || input.type === "refund")) {
        throw new LedgerFailure("unprocessable", "Income cannot use an expense category.");
      }
    }

    const effects: Effect[] = [];
    if (input.type === "transfer" || input.type === "allocation") {
      if (!input.toAccountId || input.toAccountId === input.accountId) {
        throw new LedgerFailure("bad_request", "Pick two different accounts.");
      }
      const to = await this.accounts.findById(workspaceId, input.toAccountId);
      if (!to || to.archivedAt) throw new LedgerFailure("bad_request", "Choose a valid destination account.");
      effects.push(
        { accountId: from._id, amountMinor: -amount.amountMinor, currency },
        { accountId: to._id, amountMinor: amount.amountMinor, currency },
      );
    } else if (input.type === "loan_in") {
      if (!input.toAccountId) throw new LedgerFailure("bad_request", "Choose the liability account.");
      const liability = await this.accounts.findById(workspaceId, input.toAccountId);
      if (!liability || liability.archivedAt) throw new LedgerFailure("bad_request", "Choose a valid liability account.");
      effects.push(
        { accountId: from._id, amountMinor: amount.amountMinor, currency },
        { accountId: liability._id, amountMinor: amount.amountMinor, currency },
      );
    } else if (input.type === "loan_out") {
      if (!input.toAccountId) throw new LedgerFailure("bad_request", "Choose the receivable account.");
      const recv = await this.accounts.findById(workspaceId, input.toAccountId);
      if (!recv || recv.archivedAt) throw new LedgerFailure("bad_request", "Choose a valid receivable account.");
      effects.push(
        { accountId: from._id, amountMinor: -amount.amountMinor, currency },
        { accountId: recv._id, amountMinor: amount.amountMinor, currency },
      );
    } else if (input.type === "principal_collect") {
      if (!input.toAccountId) throw new LedgerFailure("bad_request", "Choose the receivable account.");
      const recv = await this.accounts.findById(workspaceId, input.toAccountId);
      if (!recv || recv.archivedAt) throw new LedgerFailure("bad_request", "Choose a valid receivable account.");
      effects.push(
        { accountId: from._id, amountMinor: amount.amountMinor, currency },
        { accountId: recv._id, amountMinor: -amount.amountMinor, currency },
      );
    } else if (input.type === "expense") {
      effects.push({ accountId: from._id, amountMinor: -amount.amountMinor, currency });
    } else {
      effects.push({ accountId: from._id, amountMinor: amount.amountMinor, currency });
    }

    const doc: TransactionDoc = {
      _id: newId(),
      workspaceId,
      type: input.type,
      status,
      description: input.description.trim() || input.type,
      amountMinor: amount.amountMinor,
      currency,
      accountId: from._id,
      toAccountId: input.toAccountId,
      categoryId,
      merchantId,
      tagIds: input.tagIds ?? [],
      effects,
      version: 1,
      createdAt: new Date(),
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      originalTransactionId: input.originalTransactionId,
    };

    await runInTransaction(this.client, async (session) => {
      await this.txns.insert(doc, session);
      await this.operations.insert(
        { _id: newId(), operationId: input.operationId, workspaceId, entityId: doc._id, payloadHash: hash, createdAt: new Date() },
        session,
      );
      if (status === "posted") {
        for (const effect of effects) {
          await this.accounts.addBalance(effect.accountId, effect.amountMinor, session);
        }
      }
    });

    const progress = (await this.workspaces.findById(workspaceId))?.setupProgress;
    if (input.type === "expense") {
      await this.workspaces.patchSetup(workspaceId, {
        setupProgress: {
          currency: progress?.currency ?? false,
          firstAccount: progress?.firstAccount ?? true,
          opening: progress?.opening ?? false,
          categories: progress?.categories ?? false,
          firstTransaction: true,
        },
      });
    }

    return {
      status: "ok" as const,
      data: { transaction: publicTransaction(doc), totals: periodTotals(await this.txns.listPosted(workspaceId)) },
      error: null,
    };
  }
}
