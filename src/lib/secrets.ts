/**
 * Bun.secrets wrapper for per-machine secret retrieval.
 *
 * Priority (first hit wins):
 *   1. process.env[name]           — CI/production (systemd EnvironmentFile)
 *   2. Bun.secrets                 — dev local (OS keychain, encrypted at rest)
 *   3. throws (no silent fallback)
 *
 * Store once on your machine:
 *   bun -e "await Bun.secrets.set({ service: 'rpb-bot', name: 'DISCORD_TOKEN', value: 'xxxxx' })"
 *
 * Then `readSecret('DISCORD_TOKEN')` returns it without a `.env` file.
 */
const SERVICE = 'rpb-bot';

export async function readSecret(name: string): Promise<string> {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  try {
    const fromKeychain = await Bun.secrets.get({ service: SERVICE, name });
    if (fromKeychain && fromKeychain.length > 0) return fromKeychain;
  } catch {
    // OS keychain unavailable (headless CI, no libsecret) — fall through to error.
  }

  throw new Error(
    `Secret "${name}" not found. Set it via:\n` +
      `  - systemd EnvironmentFile=, OR\n` +
      `  - bun -e "await Bun.secrets.set({ service: '${SERVICE}', name: '${name}', value: '...' })"`,
  );
}

export async function writeSecret(name: string, value: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name, value });
}

export async function deleteSecret(name: string): Promise<boolean> {
  return Bun.secrets.delete({ service: SERVICE, name });
}
