import type { JobHandler } from './runner.js';
import type { WorkspaceIndex } from '../modules/ledger/ledger.repository.js';

const TICK_SECONDS = 15 * 60;

const localClock = (at: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
};

/**
 * Bill and income reminders (B2.2, TECH-SPEC 5.6). Runs every 15 minutes; due occurrences are
 * evaluated in each workspace's time zone once schedules land (Worker A B2.1).
 */
export function billRemindersJob(deps: { workspaces: WorkspaceIndex }): JobHandler {
  return {
    name: 'bill-reminders',
    everySeconds: TICK_SECONDS,
    async run() {
      await deps.workspaces.ids();
    },
  };
}

/**
 * Creates due recurring transactions just after local midnight (B2.2). The tick is every 15 minutes
 * so the first run after midnight in each time zone can post transactions when recurring exists.
 */
export function recurringDailyJob(deps: { workspaces: WorkspaceIndex; now: () => Date }): JobHandler {
  return {
    name: 'recurring-daily',
    everySeconds: TICK_SECONDS,
    async run() {
      const now = deps.now();
      for (const ws of await deps.workspaces.timeZones()) {
        const { hour, minute } = localClock(now, ws.timeZone);
        if (hour === 0 && minute < 15) {
          // Recurring postings hook up when the schedules module is available.
          void ws.id;
        }
      }
    },
  };
}
