import { systemContext } from '../common/workspace/workspace-context.js';
import { localClock, localDateString } from '../common/time/workspace-clock.js';
import type { WorkspaceIndex } from '../modules/ledger/ledger.repository.js';
import type { SchedulesService } from '../modules/schedules/schedules.service.js';
import type { WorkspacesRepository } from '../modules/workspaces/workspaces.repository.js';
import type { JobHandler } from './runner.js';

const TICK_SECONDS = 15 * 60;

/**
 * Bill and income reminders (B2.2, TECH-SPEC 5.6). Runs every 15 minutes; due occurrences are
 * evaluated in each workspace's time zone.
 */
export function billRemindersJob(deps: {
  workspaces: WorkspaceIndex;
  workspaceDocs: WorkspacesRepository;
  schedules: SchedulesService;
  now: () => Date;
}): JobHandler {
  return {
    name: 'bill-reminders',
    everySeconds: TICK_SECONDS,
    async run() {
      const now = deps.now();
      for (const ws of await deps.workspaces.timeZones()) {
        const ctx = systemContext(ws.id);
        const doc = await deps.workspaceDocs.get(ctx);
        if (!doc) continue;
        const localDate = localDateString(now, ws.timeZone);
        await deps.schedules.deliverReminders(ctx, { localDate, ownerUserId: doc.ownerId });
      }
    },
  };
}

/**
 * Creates due recurring transactions just after local midnight (B2.2). The tick is every 15 minutes
 * so the first run after midnight in each time zone can post transactions when autoPost is on.
 */
export function recurringDailyJob(deps: {
  workspaces: WorkspaceIndex;
  schedules: SchedulesService;
  now: () => Date;
}): JobHandler {
  return {
    name: 'recurring-daily',
    everySeconds: TICK_SECONDS,
    async run() {
      const now = deps.now();
      for (const ws of await deps.workspaces.timeZones()) {
        const { hour, minute } = localClock(now, ws.timeZone);
        if (hour !== 0 || minute >= 15) continue;
        const localDate = localDateString(now, ws.timeZone);
        await deps.schedules.autoPostDueOccurrences(systemContext(ws.id), localDate);
      }
    },
  };
}
