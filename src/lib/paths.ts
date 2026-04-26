import path from 'node:path';

/**
 * Resolve a path relative to the project root.
 * Handles both cases:
 * - Running from project root → cwd is /home/ubuntu/rpb-dashboard
 * - Running from bot subdir → cwd is /home/ubuntu/rpb-dashboard/bot
 */
export function resolveRootPath(...segments: string[]): string {
  const cwd = process.cwd();
  const root =
    cwd.endsWith('/bot') || cwd.endsWith('\\bot')
      ? path.resolve(cwd, '..')
      : cwd;
  return path.resolve(root, ...segments);
}

export function resolveDataPath(...segments: string[]): string {
  return resolveRootPath('data', ...segments);
}
