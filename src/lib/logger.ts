export const logger = {
  info(...args: unknown[]) {
    console.info(...args);
  },
  warn(...args: unknown[]) {
    console.warn(...args);
  },
  error(...args: unknown[]) {
    console.error(...args);
  },
  debug(...args: unknown[]) {
    if (process.env.NODE_ENV === 'development') {
      console.debug(...args);
    }
  },
  trace(...args: unknown[]) {
    if (process.env.NODE_ENV === 'development') {
      console.trace(...args);
    }
  },
  fatal(...args: unknown[]) {
    console.error('[FATAL]', ...args);
  },
};
