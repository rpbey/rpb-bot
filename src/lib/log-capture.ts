import { addLog } from './api-server.js';
import { logger } from './logger.js';

/**
 * Intercepts all logger calls to capture them in the in-memory log buffer.
 * This allows the dashboard to fetch recent logs via the bot API.
 */
export function setupLogCapture() {
  const levels = ['info', 'warn', 'error', 'debug'] as const;

  for (const level of levels) {
    const originalMethod = logger[level];

    logger[level] = (...args: unknown[]) => {
      // Call original console method
      originalMethod(...args);

      // Capture the log for API consumption
      const message = args
        .map((arg) =>
          typeof arg === 'object' ? JSON.stringify(arg) : String(arg),
        )
        .join(' ');

      addLog(level.toUpperCase(), message);
    };
  }
}
