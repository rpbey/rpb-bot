import { type ArgsOf, Discord, On } from '@rpbey/discordx';

import { RPB } from '../lib/constants.js';
import { logger } from '../lib/logger.js';

const MUDAE_BOT_ID = '432610292342587392';

/** Mudae prefix-command patterns (e.g. $wa, $wg, $hg, $mg, $ma, $ha) */
const MUDAE_CMD_REGEX = /^\$(?:wa|wg|ha|hg|ma|mg|w|m|h)\b/i;

/** Cooldown per channel — only ping once per roll session */
const rollCooldowns = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function isMudaeRoll(embeds: ArgsOf<'messageCreate'>[0]['embeds']): boolean {
  if (!embeds.length) return false;
  const embed = embeds[0];
  // Mudae roll embeds: author (character name), description (series name), image
  return !!(embed.author?.name && embed.description && embed.image?.url);
}

@Discord()
export class MudaeRollWatcher {
  @On({ event: 'messageCreate' })
  async onMessage([message]: ArgsOf<'messageCreate'>) {
    // Only watch Mudae bot messages
    if (message.author.id !== MUDAE_BOT_ID) return;
    if (!isMudaeRoll(message.embeds)) return;

    // Find who triggered the roll:
    // 1. Slash command → message.interaction.user
    // 2. $ prefix command → check message.reference or recent channel messages
    let triggeredBy = message.interaction?.user ?? null;

    if (!triggeredBy && message.reference?.messageId) {
      // Mudae sometimes replies to the user's $ command
      try {
        const refMsg = await message.channel.messages.fetch(
          message.reference.messageId,
        );
        if (MUDAE_CMD_REGEX.test(refMsg.content)) {
          triggeredBy = refMsg.author;
        }
      } catch {
        // Reference message may have been deleted
      }
    }

    if (!triggeredBy) {
      // Fallback: scan recent messages for a $ command
      try {
        const recent = await message.channel.messages.fetch({
          limit: 5,
          before: message.id,
        });
        const cmdMsg = recent.find(
          (m) =>
            !m.author.bot &&
            MUDAE_CMD_REGEX.test(m.content) &&
            // Must be within 10 seconds of the Mudae response
            message.createdTimestamp - m.createdTimestamp < 10_000,
        );
        if (cmdMsg) {
          triggeredBy = cmdMsg.author;
        }
      } catch {
        // Permission or fetch error
      }
    }

    if (!triggeredBy) return; // Can't attribute this roll

    // Cooldown key = user + channel to avoid spam
    const key = `${triggeredBy.id}-${message.channelId}`;
    const now = Date.now();
    const lastRoll = rollCooldowns.get(key);
    if (lastRoll && now - lastRoll < COOLDOWN_MS) return;

    rollCooldowns.set(key, now);

    // Clean up old cooldowns
    for (const [k, timestamp] of rollCooldowns) {
      if (now - timestamp > COOLDOWN_MS) rollCooldowns.delete(k);
    }

    try {
      await message.channel.send(
        `<@&${RPB.Roles.Mudae}> — <@${triggeredBy.id}> a lancé ses rolls ! 🎰`,
      );
      logger.info(
        `[Mudae] Roll detected from ${triggeredBy.tag ?? triggeredBy.id}, pinged Mudae role`,
      );
    } catch (error) {
      logger.error('[Mudae] Failed to send roll notification:', error);
    }
  }
}
