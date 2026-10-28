import type { ExportsService } from '../modules/exports/exports.service.js';
import type { JobHandler } from './runner.js';

/** Nightly encrypted backup of every collection (build plan B3.5). */
export function nightlyBackupJob(exports: ExportsService): JobHandler {
  return { name: 'nightly-backup', everySeconds: 86_400, maxAttempts: 3, run: () => exports.nightlyBackup() };
}

/** Clears a deleted account's workspaces, files and person records (B3.7). */
export function deleteAccountJob(exports: ExportsService): JobHandler {
  return {
    name: 'delete-account',
    maxAttempts: 10,
    async run(job) {
      if (job.payload?.userId) await exports.runDeletion(job.payload.userId);
    },
  };
}
