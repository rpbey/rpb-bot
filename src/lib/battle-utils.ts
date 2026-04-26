import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { generateBattleCard } from './canvas-utils.js';
import { RPB } from './constants.js';
import prisma from './prisma.js';

// ─── Stat Parser ────────────────────────────────────────────────────────────

export const p = (val: string | number | null | undefined): number => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

// ─── Bey Types (from Takara system) ─────────────────────────────────────────

export const BEY_TYPES = {
  ATTACK: { name: 'Attaque', emoji: '🔴', color: '#ef4444', element: 'Feu' },
  DEFENSE: { name: 'Défense', emoji: '🔵', color: '#3b82f6', element: 'Glace' },
  STAMINA: {
    name: 'Endurance',
    emoji: '🟢',
    color: '#22c55e',
    element: 'Vent',
  },
  BALANCE: {
    name: 'Équilibre',
    emoji: '🟣',
    color: '#a855f7',
    element: 'Terre',
  },
} as const;

export type BeyType = keyof typeof BEY_TYPES;

// ─── Finish Types (expanded from Takara: 6 finishes) ───────────────────────

export const FINISH_TYPES = {
  xtreme: {
    result: 'xtreme',
    name: 'X-TREME FINISH',
    message: '⚡ **X-TREME FINISH !**',
    description: 'Éjection à pleine vitesse via le X-Line !',
    points: 3,
    emoji: '⚡',
    dominantStat: 'attack' as const,
    minPowerRatio: 0.4,
    color: '#f7d301',
  },
  burst: {
    result: 'burst',
    name: 'BURST FINISH',
    message: '💥 **BURST FINISH !**',
    description: "La toupie adverse explose sous l'impact !",
    points: 2,
    emoji: '💥',
    dominantStat: 'attack' as const,
    minPowerRatio: 0.3,
    color: '#ce0c07',
  },
  over: {
    result: 'over',
    name: 'OVER FINISH',
    message: '🔄 **OVER FINISH !**',
    description: 'Éjection du stadium par la force défensive !',
    points: 2,
    emoji: '🔄',
    dominantStat: 'defense' as const,
    minPowerRatio: 0.3,
    color: '#3b82f6',
  },
  spin: {
    result: 'spin',
    name: 'SPIN FINISH',
    message: '🌀 **SPIN FINISH !**',
    description: "La toupie adverse s'arrête de tourner.",
    points: 1,
    emoji: '🌀',
    dominantStat: 'stamina' as const,
    minPowerRatio: 0.0,
    color: '#22c55e',
  },
  xcelerator: {
    result: 'xcelerator',
    name: 'X-CELERATOR FINISH',
    message: '🔥 **X-CELERATOR FINISH !**',
    description: 'Impact dévastateur depuis le Xtreme Dash !',
    points: 3,
    emoji: '🔥',
    dominantStat: 'dash' as const,
    minPowerRatio: 0.0,
    color: '#e68002',
  },
  survivor: {
    result: 'survivor',
    name: 'SURVIVOR FINISH',
    message: '🛡️ **SURVIVOR FINISH !**',
    description: 'Victoire par résistance — tous les coups encaissés !',
    points: 1,
    emoji: '🛡️',
    dominantStat: 'defense' as const,
    minPowerRatio: 0.35,
    color: '#60a5fa',
  },
} as const;

export type FinishType = keyof typeof FINISH_TYPES;

// ─── Battle Stats ───────────────────────────────────────────────────────────

export interface BattleStats {
  attack: number;
  defense: number;
  stamina: number;
  dash: number;
  power: number;
  beyType?: BeyType;
}

// ─── Type Advantage Matrix (inspired by Takara element system) ──────────────

const TYPE_ADVANTAGE: Record<BeyType, BeyType> = {
  ATTACK: 'STAMINA', // Attaque > Endurance (overwhelm)
  STAMINA: 'DEFENSE', // Endurance > Défense (outlast)
  DEFENSE: 'ATTACK', // Défense > Attaque (absorb)
  BALANCE: 'BALANCE', // Équilibre — neutral
};

function getTypeAdvantage(
  attacker: BeyType | undefined,
  defender: BeyType | undefined,
): number {
  if (
    !attacker ||
    !defender ||
    attacker === 'BALANCE' ||
    defender === 'BALANCE'
  )
    return 1.0;
  if (TYPE_ADVANTAGE[attacker] === defender) return 1.15; // 15% bonus
  if (TYPE_ADVANTAGE[defender] === attacker) return 0.88; // 12% malus
  return 1.0;
}

// ─── Detect dominant Bey type from stats ────────────────────────────────────

function detectBeyType(stats: BattleStats): BeyType {
  const { attack, defense, stamina } = stats;
  const total = attack + defense + stamina;
  if (total === 0) return 'BALANCE';

  const atkRatio = attack / total;
  const defRatio = defense / total;
  const staRatio = stamina / total;
  const threshold = 0.38;

  if (atkRatio > threshold && atkRatio >= defRatio && atkRatio >= staRatio)
    return 'ATTACK';
  if (defRatio > threshold && defRatio >= atkRatio && defRatio >= staRatio)
    return 'DEFENSE';
  if (staRatio > threshold && staRatio >= atkRatio && staRatio >= defRatio)
    return 'STAMINA';
  return 'BALANCE';
}

// ─── Get Deck Stats from DB ─────────────────────────────────────────────────

export async function getDeckStats(
  discordId: string,
): Promise<BattleStats | null> {
  const user = await prisma.user.findFirst({
    where: { discordId },
    include: {
      decks: {
        where: { isActive: true },
        include: {
          items: { include: { blade: true, ratchet: true, bit: true } },
        },
      },
    },
  });

  if (!user || user.decks.length === 0) return null;

  const deck = user.decks[0];
  let atk = 0,
    def = 0,
    sta = 0,
    dsh = 0;

  for (const item of deck.items) {
    const parts = [item.blade, item.ratchet, item.bit];
    atk += parts.reduce((acc, part) => acc + p(part?.attack), 0);
    def += parts.reduce((acc, part) => acc + p(part?.defense), 0);
    sta += parts.reduce((acc, part) => acc + p(part?.stamina), 0);
    dsh += parts.reduce((acc, part) => acc + p(part?.dash), 0);
  }

  const stats: BattleStats = {
    attack: atk,
    defense: def,
    stamina: sta,
    dash: dsh,
    power: atk + def + sta + dsh * 0.5,
  };
  stats.beyType = detectBeyType(stats);
  return stats;
}

// ─── Random Stats (for players without a deck) ─────────────────────────────

export function getRandomStats(): BattleStats {
  const atk = 100 + Math.floor(Math.random() * 50);
  const def = 100 + Math.floor(Math.random() * 50);
  const sta = 100 + Math.floor(Math.random() * 50);
  const dsh = 50 + Math.floor(Math.random() * 30);
  const stats: BattleStats = {
    attack: atk,
    defense: def,
    stamina: sta,
    dash: dsh,
    power: atk + def + sta + dsh * 0.5,
  };
  stats.beyType = detectBeyType(stats);
  return stats;
}

// ─── Determine Finish Type (sophisticated logic) ────────────────────────────

function determineFinishType(
  winnerStats: BattleStats,
  loserStats: BattleStats,
): (typeof FINISH_TYPES)[FinishType] {
  const { attack, defense, stamina, dash } = winnerStats;
  const total = attack + defense + stamina;
  if (total === 0) return FINISH_TYPES.spin;

  const atkRatio = attack / total;
  const defRatio = defense / total;
  const _staRatio = stamina / total;
  const dashBonus = dash > 50 ? 0.15 : 0;
  const powerGap =
    (winnerStats.power - loserStats.power) / Math.max(winnerStats.power, 1);

  const roll = Math.random();

  // X-Celerator: High dash + attack combo (rare, exciting)
  if (dash > 60 && atkRatio > 0.3 && roll < 0.12 + dashBonus) {
    return FINISH_TYPES.xcelerator;
  }

  // X-treme: Attack dominant + dash bonus + big power gap
  if (atkRatio > 0.35 && roll < atkRatio * 0.4 + dashBonus + powerGap * 0.1) {
    return FINISH_TYPES.xtreme;
  }

  // Burst: Attack dominant
  if (roll < atkRatio * 0.7 + dashBonus) {
    return FINISH_TYPES.burst;
  }

  // Survivor: Defense dominant + close match
  if (defRatio > 0.35 && Math.abs(powerGap) < 0.1 && roll < 0.5) {
    return FINISH_TYPES.survivor;
  }

  // Over: Defense dominant
  if (roll < atkRatio * 0.7 + defRatio * 0.6) {
    return FINISH_TYPES.over;
  }

  // Spin: Stamina wins by default
  return FINISH_TYPES.spin;
}

// ─── Calculate Battle Score (with type advantage and momentum) ──────────────

interface BattleScoreResult {
  scoreA: number;
  scoreB: number;
  typeAdvantageA: number;
  typeAdvantageB: number;
  criticalHit: 'A' | 'B' | null;
  xDash: 'A' | 'B' | null;
}

function calculateBattleScores(
  statsA: BattleStats,
  statsB: BattleStats,
): BattleScoreResult {
  // Base luck factor (0.82 - 1.18 range for more variance)
  const luckA = 0.82 + Math.random() * 0.36;
  const luckB = 0.82 + Math.random() * 0.36;

  // Type advantage
  const typeAdvA = getTypeAdvantage(statsA.beyType, statsB.beyType);
  const typeAdvB = getTypeAdvantage(statsB.beyType, statsA.beyType);

  // Critical hit chance (8%)
  const critA = Math.random() < 0.08;
  const critB = Math.random() < 0.08;
  const critMultA = critA ? 1.25 : 1.0;
  const critMultB = critB ? 1.25 : 1.0;

  // X-Dash bonus (dash > 55 gives a speed advantage)
  const xDashA = statsA.dash > 55 && Math.random() < 0.2;
  const xDashB = statsB.dash > 55 && Math.random() < 0.2;
  const xDashMultA = xDashA ? 1.15 : 1.0;
  const xDashMultB = xDashB ? 1.15 : 1.0;

  const scoreA = statsA.power * luckA * typeAdvA * critMultA * xDashMultA;
  const scoreB = statsB.power * luckB * typeAdvB * critMultB * xDashMultB;

  return {
    scoreA,
    scoreB,
    typeAdvantageA: typeAdvA,
    typeAdvantageB: typeAdvB,
    criticalHit: critA ? 'A' : critB ? 'B' : null,
    xDash: xDashA ? 'A' : xDashB ? 'B' : null,
  };
}

// ─── Build Battle Narrative ─────────────────────────────────────────────────

function buildBattleNarrative(
  scores: BattleScoreResult,
  winnerIsA: boolean,
  finish: (typeof FINISH_TYPES)[FinishType],
  challengerName: string,
  opponentName: string,
): string[] {
  const lines: string[] = [];
  const winnerName = winnerIsA ? challengerName : opponentName;

  if (scores.xDash) {
    const dasher = scores.xDash === 'A' ? challengerName : opponentName;
    lines.push(`💨 **${dasher}** active le **Xtreme Dash** !`);
  }

  if (scores.typeAdvantageA > 1 || scores.typeAdvantageB > 1) {
    const advantaged =
      scores.typeAdvantageA > 1 ? challengerName : opponentName;
    lines.push(`🎯 **${advantaged}** a l'avantage de type !`);
  }

  if (scores.criticalHit) {
    const critter = scores.criticalHit === 'A' ? challengerName : opponentName;
    lines.push(`💢 **${critter}** porte un coup critique !`);
  }

  lines.push(`${finish.emoji} **${winnerName}** remporte le combat !`);
  lines.push(`> *${finish.description}*`);

  return lines;
}

// ─── Discord Types ──────────────────────────────────────────────────────────

import { type ImageURLOptions } from 'discord.js';

interface BattleUser {
  id: string;
  displayName: string;
  displayAvatarURL: (opts?: ImageURLOptions) => string;
}

interface BattleInteraction {
  replied: boolean;
  deferred: boolean;
  editReply: (options: Record<string, unknown>) => Promise<unknown>;
  reply: (options: Record<string, unknown>) => Promise<unknown>;
}

// ─── Main Battle Simulation ─────────────────────────────────────────────────

export async function runBattleSimulation(
  interaction: BattleInteraction,
  challenger: BattleUser,
  opponent: BattleUser,
  statsA: BattleStats,
  statsB: BattleStats,
) {
  // Ensure types are detected
  if (!statsA.beyType) statsA.beyType = detectBeyType(statsA);
  if (!statsB.beyType) statsB.beyType = detectBeyType(statsB);

  // Calculate scores with all modifiers
  const scores = calculateBattleScores(statsA, statsB);

  const winnerIsA = scores.scoreA > scores.scoreB;
  const winner = winnerIsA ? challenger : opponent;
  const loser = winner.id === challenger.id ? opponent : challenger;
  const winnerStats = winnerIsA ? statsA : statsB;
  const loserStats = winnerIsA ? statsB : statsA;

  // Determine finish type
  const finishType = determineFinishType(winnerStats, loserStats);

  // Build narrative
  const narrative = buildBattleNarrative(
    scores,
    winnerIsA,
    finishType,
    challenger.displayName,
    opponent.displayName,
  );

  // Update DB
  try {
    const dbWinner = await prisma.user.upsert({
      where: { discordId: winner.id },
      update: {},
      create: {
        discordId: winner.id,
        name: winner.displayName,
        email: `${winner.id}@discord.rpbey.fr`,
      },
    });
    await prisma.profile.upsert({
      where: { userId: dbWinner.id },
      update: { wins: { increment: 1 } },
      create: { userId: dbWinner.id, wins: 1 },
    });

    const dbLoser = await prisma.user.upsert({
      where: { discordId: loser.id },
      update: {},
      create: {
        discordId: loser.id,
        name: loser.displayName,
        email: `${loser.id}@discord.rpbey.fr`,
      },
    });
    await prisma.profile.upsert({
      where: { userId: dbLoser.id },
      update: { losses: { increment: 1 } },
      create: { userId: dbLoser.id, losses: 1 },
    });
  } catch (e) {
    console.error('DB Update Error:', e);
  }

  // Generate Card
  const cardBuffer = await generateBattleCard({
    winnerName: winner.displayName,
    winnerAvatarUrl: winner.displayAvatarURL({ extension: 'png', size: 512 }),
    loserName: loser.displayName,
    loserAvatarUrl: loser.displayAvatarURL({ extension: 'png', size: 512 }),
    finishType: finishType.result,
    finishMessage: finishType.message,
    finishEmoji: finishType.emoji,
    winnerType: winnerStats.beyType,
    loserType: loserStats.beyType,
    winnerStats,
    loserStats,
    narrative,
    finishColor: finishType.color,
  });

  const filename = `battle-${Date.now()}.png`;
  const attachment = new AttachmentBuilder(cardBuffer, { name: filename });

  const typeInfoA = statsA.beyType ? BEY_TYPES[statsA.beyType] : null;
  const typeInfoB = statsB.beyType ? BEY_TYPES[statsB.beyType] : null;

  const resultEmbed = new EmbedBuilder()
    .setColor(parseInt(finishType.color.replace('#', ''), 16))
    .setAuthor({
      name: `${finishType.name} — ${finishType.points} point${finishType.points > 1 ? 's' : ''}`,
    })
    .setDescription(narrative.join('\n'))
    .addFields(
      {
        name: `${typeInfoA?.emoji ?? '⚪'} ${challenger.displayName}`,
        value: `ATK \`${statsA.attack}\` DEF \`${statsA.defense}\` STA \`${statsA.stamina}\` DSH \`${statsA.dash}\``,
        inline: true,
      },
      {
        name: `${typeInfoB?.emoji ?? '⚪'} ${opponent.displayName}`,
        value: `ATK \`${statsB.attack}\` DEF \`${statsB.defense}\` STA \`${statsB.stamina}\` DSH \`${statsB.dash}\``,
        inline: true,
      },
    )
    .setImage(`attachment://${filename}`)
    .setFooter({ text: `${RPB.FullName} • Que votre esprit de Blader brûle !` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`battle-rematch-${loser.id}`)
      .setLabel('Revanche !')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId(`battle-stats-${winner.id}-${loser.id}`)
      .setLabel('Détails')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📊'),
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({
      embeds: [resultEmbed],
      files: [attachment],
      components: [row],
    });
  } else {
    await interaction.reply({
      embeds: [resultEmbed],
      files: [attachment],
      components: [row],
    });
  }
}
