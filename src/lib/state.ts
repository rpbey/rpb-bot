/**
 * Shared state for the RPB Bot
 * This helps avoid duplicate instances of state when multiple files (e.g. commands and interaction handlers)
 * need to access the same data.
 */

interface PendingBattle {
  opponentId: string;
  channelId: string;
  timestamp: number;
}

/**
 * Store pending battles: challengerId -> { opponentId, channelId, timestamp }
 */
export const pendingBattles = new Map<string, PendingBattle>();
