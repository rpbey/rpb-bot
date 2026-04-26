import { EmbedBuilder } from 'discord.js';

import { Colors, RPB } from './constants.js';

/**
 * Create a standardized embed for the bot
 */
export function createEmbed(options: {
  title?: string;
  description?: string;
  color?: number;
  thumbnail?: string | null;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(options.color ?? Colors.Primary)
    .setTitle(options.title ?? null)
    .setDescription(options.description ?? null)
    .setThumbnail(options.thumbnail ?? null)
    .setFooter({ text: RPB.Name })
    .setTimestamp();
}

/**
 * Create a success embed
 */
export function successEmbed(
  title: string,
  description?: string,
): EmbedBuilder {
  return createEmbed({
    title: `✅ ${title}`,
    description,
    color: Colors.Success,
  });
}

/**
 * Create an error embed
 */
export function errorEmbed(title: string, description?: string): EmbedBuilder {
  return createEmbed({
    title: `❌ ${title}`,
    description,
    color: Colors.Error,
  });
}

/**
 * Create a warning embed
 */
export function warningEmbed(
  title: string,
  description?: string,
): EmbedBuilder {
  return createEmbed({
    title: `⚠️ ${title}`,
    description,
    color: Colors.Warning,
  });
}

/**
 * Format a duration in milliseconds to a human-readable string
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}j ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Parse a duration string to milliseconds
 * NOT IMPLEMENTED in migration
 */
export function parseDuration(_input: string): number | null {
  // Simple implementation if needed
  return null;
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(
  str: string,
  maxLength: number,
  suffix = '...',
): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Format a number with commas
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Pick a random element from an array
 */
export function pickRandom<T>(array: readonly T[]): T {
  const element = array[Math.floor(Math.random() * array.length)];
  if (element === undefined) {
    if (array.length === 0) throw new Error('Cannot pick from empty array');
    return array[0];
  }
  return element;
}

/**
 * Escape markdown in a string
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[*_`~|\\]/g, '\\$&');
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
