import type { Db } from 'mongodb';
import type { z } from 'zod';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { BuilderSpec, ReportCard } from './reports.contract.js';

export type ReportDashboardDoc = {
  _id: string;
  workspaceId: string;
  name: string;
  sortOrder: number;
  cards: z.output<typeof ReportCard>[];
  operationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type SavedReportDoc = {
  _id: string;
  workspaceId: string;
  name: string;
  spec: z.output<typeof BuilderSpec>;
  operationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class ReportDashboardsRepository extends BaseRepository<ReportDashboardDoc> {
  constructor(db: Db) {
    super(db, 'report_dashboards');
  }
}

export class SavedReportsRepository extends BaseRepository<SavedReportDoc> {
  constructor(db: Db) {
    super(db, 'saved_reports');
  }
}
