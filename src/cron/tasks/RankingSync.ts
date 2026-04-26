import { logger } from "../../lib/logger.js";

/**
 * Poke l'API rpb-dashboard pour sync les rankings (WB + SATR) depuis
 * les Google Sheets autoritatives.
 *
 * Côté dashboard (`/api/admin/ranking/sync`), chaque saison :
 *   - essaie la Sheet officielle (S1 et S2 SATR, WB season 2 bientôt)
 *   - fallback sur le calcul local Ichigo si la sheet n'est pas accessible.
 *
 * Auth : Bearer $RANKING_SYNC_TOKEN (shared avec rpb-dashboard/.env).
 */
export async function rankingSyncTask() {
  const token = process.env.RANKING_SYNC_TOKEN;
  if (!token) {
    logger.warn("[Cron] RANKING_SYNC_TOKEN manquant — ranking sync désactivée");
    return;
  }

  const apiUrl = process.env.RPB_API_URL?.replace(/\/$/, "") ?? "https://rpbey.fr";
  const endpoint = `${apiUrl}/api/admin/ranking/sync?skip=stardust`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      results?: Array<{
        name: string;
        success: boolean;
        count?: number;
        error?: string;
      }>;
    };

    if (!res.ok || !body.ok) {
      logger.error(`[Cron] Ranking sync failed (HTTP ${res.status}) : ${JSON.stringify(body)}`);
      return;
    }

    const summary = (body.results ?? [])
      .map((r) => `${r.name}=${r.success ? r.count : `❌${r.error}`}`)
      .join(" · ");
    logger.info(`[Cron] Ranking sync OK — ${summary}`);
  } catch (err) {
    logger.error(`[Cron] Ranking sync error : ${String(err)}`);
  }
}
