/**
 * Prevents two bot processes from running in parallel.
 *
 * Two layers of defense:
 *   1. PID lock file — atomic O_EXCL create. If another live PID owns it, abort.
 *      Stale files (dead PID) are recycled.
 *   2. Port bind — the api-server's Bun.serve will throw EADDRINUSE if the
 *      port is already taken, caught and reported by startApiServer.
 *
 * Systemd alone prevents double-start of the service unit, but does NOT stop
 * a human running `bun src/index.ts` by hand while the service is live —
 * this guard catches that case and exits cleanly.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { resolve } from "node:path";

type Cleanup = () => void;

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 = existence probe. Throws ESRCH if dead, EPERM if alive-but-not-ours.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreateLock(path: string): number | null {
  try {
    return openSync(path, "wx"); // O_WRONLY | O_CREAT | O_EXCL — atomic
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
}

function defaultLockPath(): string {
  // Honor explicit override first (e.g., systemd RuntimeDirectory=/run/rpb-bot).
  if (process.env.BOT_LOCK_FILE) return process.env.BOT_LOCK_FILE;
  // Fall back to the bot's `data/` dir (listed in ReadWritePaths).
  // Historical `bot/data/` path was a relic of the monorepo merge — now gone.
  return resolve(process.cwd(), "data", ".bot.pid");
}

export function claimSingletonOrExit(lockPath = defaultLockPath()): Cleanup {
  let fd = tryCreateLock(lockPath);

  if (fd === null) {
    // Existing lock — check if the owner is still alive.
    let existing: number | null = null;
    try {
      existing = Number(readFileSync(lockPath, "utf8").trim());
    } catch {
      // Unreadable — treat as stale
    }

    if (existing && existing !== process.pid && isAlive(existing)) {
      console.error(
        `[singleton] Another bot instance is already running (pid=${existing}).\n` +
          `  Lock: ${lockPath}\n` +
          `  Refusing to start a duplicate. Use 'sudo systemctl restart rpb-bot' or kill the other process first.`,
      );
      process.exit(11);
    }

    // Stale or self-owned (shouldn't happen, but harmless) — recycle.
    try {
      unlinkSync(lockPath);
    } catch {
      /* race window if another process just removed it */
    }
    fd = tryCreateLock(lockPath);
    if (fd === null) {
      console.error(`[singleton] Lock at ${lockPath} is contended (concurrent startup). Aborting.`);
      process.exit(12);
    }
  }

  writeSync(fd, String(process.pid));
  closeSync(fd);

  let released = false;
  const cleanup: Cleanup = () => {
    if (released) return;
    released = true;
    try {
      const owner = Number(readFileSync(lockPath, "utf8").trim());
      if (owner === process.pid) unlinkSync(lockPath);
    } catch {
      /* nothing to clean */
    }
  };

  // Best-effort release on every exit path.
  process.once("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      cleanup();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
  process.once("uncaughtException", (err) => {
    console.error("[singleton] uncaughtException — releasing lock:", err);
    cleanup();
    process.exit(1);
  });

  return cleanup;
}
