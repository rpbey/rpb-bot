import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

export async function sessionCleanupTask() {
  logger.info('[Cron] Running session cleanup...');

  try {
    const deleted = await prisma.session.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });

    const deletedVerifications = await prisma.verification.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });

    logger.info(
      `[Cron] Cleanup complete: ${deleted.count} sessions, ${deletedVerifications.count} verifications deleted`,
    );
  } catch (error) {
    logger.error('[Cron] Session cleanup error:', error);
  }
}
