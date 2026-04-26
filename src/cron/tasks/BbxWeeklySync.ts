import { logger } from '../../lib/logger.js';
import { resolveRootPath } from '../../lib/paths.js';

export async function bbxWeeklySyncTask() {
  logger.info('[Cron] Synchronisation BBX Weekly...');

  try {
    const proc = Bun.spawnSync(['bun', 'scripts/scrape-bbx-weekly.ts'], {
      cwd: resolveRootPath(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = proc.stdout.toString();
    if (proc.exitCode !== 0) {
      throw new Error(proc.stderr.toString() || `Exit code ${proc.exitCode}`);
    }

    logger.info(
      `[Cron] BBX Weekly sync terminée: ${output.trim().split('\n').pop()}`,
    );
  } catch (error) {
    logger.error('[Cron] Erreur synchronisation BBX Weekly:', error);
  }
}
