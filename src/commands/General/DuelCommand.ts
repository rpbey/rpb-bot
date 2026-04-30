import { ActionRowBuilder, ApplicationCommandOptionType, AttachmentBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags, StringSelectMenuBuilder, type ButtonInteraction, type CommandInteraction, type Message, type User } from "discord.js";
import {
  ButtonComponent,
  Discord,
  Slash,
  SlashGroup,
  SlashOption,
} from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import { PrismaService } from '../../lib/prisma.js';

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATION NOTE (2026-04-30) — TCG Duel
// ═══════════════════════════════════════════════════════════════════════════════
// The gacha service exposes the full TCG duel pipeline at:
//   POST /api/duel/propose, /accept, /decline, /play, /forfeit
//   GET  /api/duel/active, /history
// Use `createGachaClient()` from `lib/gacha-api.ts` for typed wrappers.
//
// This file intentionally keeps direct Prisma access for now — the rich
// Discord UI flow (buttons, select menus, animation delays, ELO display) is
// tightly coupled to the local DB shape. A full migration to the API would
// require rewriting the FSM-driven UI layer. Until then, both paths work
// against the same shared PG18 DB (latency ~0 ms) so behaviour is identical.
//
// Refactor priority: P3 — only after the FSM in gacha/services/duel.ts
// becomes the single source of truth (drop in-memory liveDuels Map and
// fully persist intermediate states).
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const CHALLENGE_TIMEOUT = 60_000;
const SELECTION_TIMEOUT = 90_000;
const ROUND_DELAY = 3_500;
const DUEL_COOLDOWN = 3 * 60_000;
const ELO_K = 32;

const RARITY_POWER: Record<string, number> = {
  COMMON: 0,
  RARE: 12,
  SUPER_RARE: 28,
  LEGENDARY: 50,
  SECRET: 70,
};

const RARITY_EMOJI: Record<string, string> = {
  COMMON: '⚪',
  RARE: '🔵',
  SUPER_RARE: '🟣',
  LEGENDARY: '🟡',
  SECRET: '🔴',
};

const RARITY_LABEL: Record<string, string> = {
  COMMON: 'Commune',
  RARE: 'Rare',
  SUPER_RARE: 'Super Rare',
  LEGENDARY: 'Légendaire',
  SECRET: 'Secrète',
};

const ELEMENT_EMOJI: Record<string, string> = {
  FEU: '🔥',
  EAU: '💧',
  TERRE: '🌍',
  VENT: '🌪️',
  OMBRE: '🌑',
  LUMIERE: '✨',
  NEUTRAL: '⚪',
};

const ELEMENT_NAME: Record<string, string> = {
  FEU: 'Feu',
  EAU: 'Eau',
  TERRE: 'Terre',
  VENT: 'Vent',
  OMBRE: 'Ombre',
  LUMIERE: 'Lumière',
  NEUTRAL: 'Neutre',
};

const ELEMENT_BEATS: Record<string, string> = {
  FEU: 'VENT',
  VENT: 'TERRE',
  TERRE: 'EAU',
  EAU: 'FEU',
  OMBRE: 'LUMIERE',
  LUMIERE: 'OMBRE',
};

const FINISH_TYPES = [
  { min: 1.6, msg: '⚡ X-TREME FINISH !', emoji: '⚡', color: 0xfbbf24 },
  { min: 1.35, msg: '💥 BURST FINISH !', emoji: '💥', color: 0xef4444 },
  { min: 1.1, msg: '🔄 OVER FINISH !', emoji: '🔄', color: 0x8b5cf6 },
  { min: 0, msg: '🌀 SPIN FINISH !', emoji: '🌀', color: 0x22c55e },
];

const ROUND_INTROS = [
  [
    'Le sol tremble...',
    'Les Beyblades sont lancées !',
    "C'est parti !",
    "L'arène s'illumine !",
  ],
  [
    'La tension monte...',
    'Deuxième confrontation !',
    'Les arènes vibrent !',
    'Le public retient son souffle !',
  ],
  [
    'Round décisif !',
    'Tout se joue maintenant !',
    "C'est le moment de vérité !",
    'La dernière chance !',
  ],
];

const RANK_TIERS = [
  { min: 1800, name: 'Maître', emoji: '👑', color: '#fbbf24' },
  { min: 1500, name: 'Diamant', emoji: '💎', color: '#22d3ee' },
  { min: 1300, name: 'Platine', emoji: '🔷', color: '#a78bfa' },
  { min: 1100, name: 'Or', emoji: '🥇', color: '#f59e0b' },
  { min: 900, name: 'Argent', emoji: '🥈', color: '#9ca3af' },
  { min: 0, name: 'Bronze', emoji: '🥉', color: '#cd7f32' },
];

// Prevent concurrent duels
const activePlayers = new Set<string>();
const cooldowns = new Map<string, number>();

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface DuelCard {
  id: string;
  name: string;
  rarity: string;
  element: string;
  att: number;
  def: number;
  end: number;
  equilibre: number;
  imageUrl: string | null;
  specialMove: string | null;
  beyblade: string | null;
  series: string;
}

interface RoundResult {
  cardA: DuelCard;
  cardB: DuelCard;
  powerA: number;
  powerB: number;
  winner: 'A' | 'B';
  events: string[];
  mvpDelta: number; // power margin of victory
}

type CardRow = {
  id: string;
  name: string;
  rarity: string;
  element: string;
  att: number;
  def: number;
  end: number;
  equilibre: number;
  imageUrl: string | null;
  specialMove: string | null;
  beyblade: string | null;
  series: string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// BATTLE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function computePower(
  card: DuelCard,
  opponentElement: string,
  bonuses: {
    synergy: boolean;
    underdog: boolean;
    momentum: boolean;
    lastStand: boolean;
  },
): { power: number; events: string[] } {
  const events: string[] = [];

  // Base power from real card stats
  const base =
    card.att * 1.2 + card.def * 0.6 + card.end * 0.8 + card.equilibre * 0.4;
  const rarityBonus = RARITY_POWER[card.rarity] ?? 0;

  let mult = 1.0;

  // Element advantage (×1.5) / disadvantage (×0.75)
  if (ELEMENT_BEATS[card.element] === opponentElement) {
    mult *= 1.5;
    events.push(
      `${ELEMENT_EMOJI[card.element] ?? ''} **${ELEMENT_NAME[card.element]}** domine **${ELEMENT_NAME[opponentElement]}** !`,
    );
  } else if (ELEMENT_BEATS[opponentElement] === card.element) {
    mult *= 0.75;
  }

  // Critical hit (12%)
  if (Math.random() < 0.12) {
    mult *= 1.4;
    events.push('⚡ **Coup critique** — puissance décuplée !');
  }

  // Special move trigger (10% if card has one)
  if (card.specialMove && Math.random() < 0.1) {
    mult *= 1.35;
    events.push(`💫 **${card.specialMove}** déclenché !`);
  }

  // Defense wall (8% — defender absorbs damage)
  if (card.def > 60 && Math.random() < 0.08) {
    mult *= 0.7;
    events.push('🛡️ **Mur de défense** — impact absorbé !');
  }

  // Synergy bonus: team shares elements → +10%
  if (bonuses.synergy) {
    mult *= 1.1;
    events.push('🔗 **Synergie élémentaire** — équipe harmonisée !');
  }

  // Underdog: lower total team power → +12%
  if (bonuses.underdog) {
    mult *= 1.12;
    events.push('🔥 **Underdog** — la rage du plus faible !');
  }

  // Momentum: won previous round → +6%
  if (bonuses.momentum) {
    mult *= 1.06;
    events.push('💨 **Momentum** — sur sa lancée !');
  }

  // Last Stand: losing 0-1, this is the last card → +15%
  if (bonuses.lastStand) {
    mult *= 1.15;
    events.push('🔥 **Dernier souffle** — tout ou rien !');
  }

  // Random variance (±15%)
  const variance = 0.85 + Math.random() * 0.3;

  return {
    power: Math.round((base + rarityBonus) * mult * variance * 100) / 100,
    events,
  };
}

function hasSynergy(cards: DuelCard[]): boolean {
  const elements = cards.map((c) => c.element).filter((e) => e !== 'NEUTRAL');
  if (elements.length < 2) return false;
  return new Set(elements).size === 1; // all same non-neutral element
}

function teamPower(cards: DuelCard[]): number {
  return cards.reduce((s, c) => s + c.att + c.def + c.end + c.equilibre, 0);
}

function resolveRound(
  cardA: DuelCard,
  cardB: DuelCard,
  bonusesA: {
    synergy: boolean;
    underdog: boolean;
    momentum: boolean;
    lastStand: boolean;
  },
  bonusesB: {
    synergy: boolean;
    underdog: boolean;
    momentum: boolean;
    lastStand: boolean;
  },
): RoundResult {
  const a = computePower(cardA, cardB.element, bonusesA);
  const b = computePower(cardB, cardA.element, bonusesB);

  const winner: 'A' | 'B' = a.power >= b.power ? 'A' : 'B';
  const mvpDelta = Math.abs(a.power - b.power);

  return {
    cardA,
    cardB,
    powerA: a.power,
    powerB: b.power,
    winner,
    events: [...a.events, ...b.events],
    mvpDelta,
  };
}

function getFinish(avgRatio: number) {
  return FINISH_TYPES.find((f) => avgRatio >= f.min) ?? FINISH_TYPES[3]!;
}

function getRankTier(rating: number) {
  return RANK_TIERS.find((t) => rating >= t.min) ?? RANK_TIERS[5]!;
}

function cardSortPower(c: {
  att: number;
  def: number;
  end: number;
  equilibre: number;
}): number {
  return c.att + c.def + c.end + c.equilibre;
}

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function powerBar(value: number, max: number, len = 10): string {
  const filled = Math.round((value / Math.max(max, 1)) * len);
  return (
    '█'.repeat(Math.min(filled, len)) + '░'.repeat(Math.max(len - filled, 0))
  );
}

function calcElo(
  ratingA: number,
  ratingB: number,
  winnerIsA: boolean,
): { newA: number; newB: number; deltaA: number; deltaB: number } {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const actualA = winnerIsA ? 1 : 0;
  const actualB = winnerIsA ? 0 : 1;
  const deltaA = Math.round(ELO_K * (actualA - expectedA));
  const deltaB = Math.round(ELO_K * (actualB - expectedB));
  return {
    newA: ratingA + deltaA,
    newB: ratingB + deltaB,
    deltaA,
    deltaB,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════════════════════════════════

@Discord()
@SlashGroup({ name: 'duel', description: 'Système de duels TCG stratégiques' })
@SlashGroup('duel')
@injectable()
export class DuelCommand {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  private async ensureProfile(discordId: string, displayName: string) {
    let user = await this.prisma.user.findUnique({
      where: { discordId },
      include: { profile: true },
    });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          discordId,
          name: displayName,
          email: `${discordId}@discord.rpbey.fr`,
          profile: { create: {} },
        },
        include: { profile: true },
      });
    }
    if (!user.profile) {
      const profile = await this.prisma.profile.create({
        data: { userId: user.id },
      });
      return { ...user, profile };
    }
    return user;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /duel combat — Main battle command
  // ══════════════════════════════════════════════════════════════════════════════

  @Slash({
    name: 'combat',
    description: '⚔️ Défier un adversaire en duel de cartes (Best of 3)',
  })
  @SlashGroup('duel')
  async combat(
    @SlashOption({
      name: 'adversaire',
      description: 'Le joueur à défier',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    @SlashOption({
      name: 'mise',
      description: 'Mise en pièces (0 = amical)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
      minValue: 0,
      maxValue: 5000,
    })
    bet: number = 0,
    interaction: CommandInteraction,
  ) {
    // ── Validations ──
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Tu ne peux pas te défier toi-même !',
        flags: MessageFlags.Ephemeral,
      });
    if (target.bot)
      return interaction.reply({
        content: '❌ Pas de duel contre un bot !',
        flags: MessageFlags.Ephemeral,
      });
    if (activePlayers.has(interaction.user.id) || activePlayers.has(target.id))
      return interaction.reply({
        content: '❌ Un des joueurs est déjà en duel !',
        flags: MessageFlags.Ephemeral,
      });

    const now = Date.now();
    const cd = cooldowns.get(interaction.user.id) ?? 0;
    if (now < cd) {
      const secs = Math.ceil((cd - now) / 1000);
      return interaction.reply({
        content: `⏳ Cooldown : **${secs}s** avant un nouveau duel.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const [userA, userB] = await Promise.all([
      this.ensureProfile(interaction.user.id, interaction.user.displayName),
      this.ensureProfile(target.id, target.displayName),
    ]);

    const [invA, invB] = await Promise.all([
      this.prisma.cardInventory.findMany({
        where: { userId: userA.id },
        include: { card: true },
      }),
      this.prisma.cardInventory.findMany({
        where: { userId: userB.id },
        include: { card: true },
      }),
    ]);

    if (invA.length < 3)
      return interaction.reply({
        content: `❌ Il te faut **3 cartes** minimum ! (${invA.length}/3) — \`/gacha gacha\``,
        flags: MessageFlags.Ephemeral,
      });
    if (invB.length < 3)
      return interaction.reply({
        content: `❌ **${target.displayName}** a besoin de **3 cartes** minimum ! (${invB.length}/3)`,
        flags: MessageFlags.Ephemeral,
      });
    if (bet > 0 && (userA.profile?.currency ?? 0) < bet)
      return interaction.reply({
        content: `❌ Solde insuffisant ! (${userA.profile?.currency ?? 0} 🪙)`,
        flags: MessageFlags.Ephemeral,
      });
    if (bet > 0 && (userB.profile?.currency ?? 0) < bet)
      return interaction.reply({
        content: `❌ **${target.displayName}** n'a pas assez de 🪙 !`,
        flags: MessageFlags.Ephemeral,
      });

    // ── Lock players ──
    activePlayers.add(interaction.user.id);
    activePlayers.add(target.id);
    const cleanup = () => {
      activePlayers.delete(interaction.user.id);
      activePlayers.delete(target.id);
    };

    try {
      await this.runDuel(
        interaction,
        target,
        bet,
        userA as { id: string; profile: NonNullable<typeof userA.profile> },
        userB as { id: string; profile: NonNullable<typeof userB.profile> },
        invA,
        invB,
      );
    } catch (err) {
      logger.error('[Duel] Unexpected error:', err);
      try {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ Erreur')
              .setDescription('Le duel a été interrompu.')
              .setColor(Colors.Error),
          ],
          components: [],
        });
      } catch {
        /* noop */
      }
    } finally {
      cleanup();
    }
  }

  private async runDuel(
    interaction: CommandInteraction,
    target: User,
    bet: number,
    userA: {
      id: string;
      profile: {
        currency: number;
        duelRating: number;
        duelWins: number;
        duelLosses: number;
        duelStreak: number;
        duelBestStreak: number;
      };
    },
    userB: {
      id: string;
      profile: {
        currency: number;
        duelRating: number;
        duelWins: number;
        duelLosses: number;
        duelStreak: number;
        duelBestStreak: number;
      };
    },
    invA: Array<{ card: CardRow }>,
    invB: Array<{ card: CardRow }>,
  ) {
    const nameA = interaction.user.displayName;
    const nameB = target.displayName;
    const duelId = Date.now().toString(36);
    const profileA = userA.profile;
    const profileB = userB.profile;
    const tierA = getRankTier(profileA.duelRating);
    const tierB = getRankTier(profileB.duelRating);

    // ══════════════ PHASE 1: CHALLENGE ══════════════

    const winRateA =
      profileA.duelWins + profileA.duelLosses > 0
        ? Math.round(
            (profileA.duelWins / (profileA.duelWins + profileA.duelLosses)) *
              100,
          )
        : 0;
    const winRateB =
      profileB.duelWins + profileB.duelLosses > 0
        ? Math.round(
            (profileB.duelWins / (profileB.duelWins + profileB.duelLosses)) *
              100,
          )
        : 0;

    const challengeEmbed = new EmbedBuilder()
      .setTitle('⚔️ Défi en Duel !')
      .setDescription(
        `**${interaction.user}** défie **${target}** !\n\n` +
          `📋 **Format :** Best of 3 — Choisis 3 cartes\n` +
          `🎯 **Matchup :** Rang par rang (forte vs forte)\n` +
          `💰 **Mise :** ${bet > 0 ? `**${bet}** 🪙 chacun` : 'Aucune (amical)'}\n` +
          `\n` +
          `┌─── ${tierA.emoji} **${nameA}** ───\n` +
          `│ ${tierA.name} · **${profileA.duelRating}** ELO · ${profileA.duelWins}V/${profileA.duelLosses}D (${winRateA}%)` +
          `${profileA.duelStreak >= 3 ? ` · 🔥${profileA.duelStreak}` : ''}\n` +
          `└─── ${tierB.emoji} **${nameB}** ───\n` +
          `│ ${tierB.name} · **${profileB.duelRating}** ELO · ${profileB.duelWins}V/${profileB.duelLosses}D (${winRateB}%)` +
          `${profileB.duelStreak >= 3 ? ` · 🔥${profileB.duelStreak}` : ''}\n\n` +
          `${target}, acceptes-tu ?`,
      )
      .setColor(Colors.Primary)
      .setThumbnail(interaction.user.displayAvatarURL({ size: 128 }))
      .setFooter({ text: 'Expire dans 60 secondes' });

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`duel-accept-${duelId}`)
        .setLabel('⚔️ Accepter')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`duel-decline-${duelId}`)
        .setLabel('Refuser')
        .setStyle(ButtonStyle.Secondary),
    );

    const challengeMsg = (await interaction.reply({
      embeds: [challengeEmbed],
      components: [buttons],
      fetchReply: true,
    })) as Message;

    let btnResponse:
      | Awaited<ReturnType<typeof challengeMsg.awaitMessageComponent>>
      | undefined;
    try {
      btnResponse = await challengeMsg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === target.id,
        time: CHALLENGE_TIMEOUT,
      });
    } catch {
      return interaction.editReply({
        embeds: [
          challengeEmbed
            .setDescription(`⏰ **${nameB}** n'a pas répondu à temps.`)
            .setColor(Colors.Warning),
        ],
        components: [],
      });
    }

    if (btnResponse.customId.includes('decline')) {
      return btnResponse.update({
        embeds: [
          challengeEmbed
            .setDescription(`${nameB} a **refusé** le duel.`)
            .setColor(Colors.Error),
        ],
        components: [],
      });
    }

    // ══════════════ PHASE 2: CARD SELECTION ══════════════

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎴 Sélection des cartes...')
          .setDescription(
            `${nameA} et ${nameB} choisissent leurs 3 cartes.\n⏳ **90 secondes** pour décider.\n\n> 💡 **Astuce :** Choisis des cartes du même élément pour activer le **bonus Synergie** (+10%)`,
          )
          .setColor(Colors.Secondary),
      ],
      components: [],
    });

    const buildOptions = (inv: typeof invA) =>
      inv
        .sort((a, b) => cardSortPower(b.card) - cardSortPower(a.card))
        .slice(0, 25)
        .map((item) => {
          const c = item.card;
          const pwr = c.att + c.def + c.end;
          const el = ELEMENT_EMOJI[c.element] ?? '⚪';
          const rar = RARITY_LABEL[c.rarity] ?? c.rarity;
          let desc = `${rar} · ${el} ${ELEMENT_NAME[c.element] ?? c.element} · PWR ${pwr}`;
          if (desc.length > 100) desc = `${desc.slice(0, 97)}...`;
          let label = c.name;
          if (label.length > 100) label = `${label.slice(0, 97)}...`;
          return { label, description: desc, value: c.id };
        });

    const menuA = new StringSelectMenuBuilder()
      .setCustomId(`duel-sel-a-${duelId}`)
      .setPlaceholder('Choisis 3 cartes...')
      .setMinValues(3)
      .setMaxValues(3)
      .addOptions(buildOptions(invA));

    const menuB = new StringSelectMenuBuilder()
      .setCustomId(`duel-sel-b-${duelId}`)
      .setPlaceholder('Choisis 3 cartes...')
      .setMinValues(3)
      .setMaxValues(3)
      .addOptions(buildOptions(invB));

    const [selMsgA, selMsgB] = await Promise.all([
      interaction.followUp({
        content:
          '🎴 **Choisis 3 cartes** pour le duel :\n> Même élément = **+10% Synergie** · Rang par rang (forte vs forte)',
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menuA),
        ],
        flags: MessageFlags.Ephemeral,
      }),
      btnResponse.reply({
        content:
          '🎴 **Choisis 3 cartes** pour le duel :\n> Même élément = **+10% Synergie** · Rang par rang (forte vs forte)',
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menuB),
        ],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
      }),
    ]);

    const awaitSel = (msg: Message, userId: string): Promise<string[]> =>
      new Promise((resolve, reject) => {
        const collector = msg.createMessageComponentCollector({
          componentType: ComponentType.StringSelect,
          filter: (i) => i.user.id === userId,
          time: SELECTION_TIMEOUT,
          max: 1,
        });
        collector.on('collect', async (i) => {
          await i.update({
            content: '✅ Cartes sélectionnées ! En attente...',
            components: [],
          });
          resolve(i.values);
        });
        collector.on('end', (collected) => {
          if (collected.size === 0) reject(new Error('timeout'));
        });
      });

    let picksA: string[];
    let picksB: string[];
    try {
      [picksA, picksB] = await Promise.all([
        awaitSel(selMsgA as Message, interaction.user.id),
        awaitSel(selMsgB as Message, target.id),
      ]);
    } catch {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏰ Temps écoulé !')
            .setDescription("Un joueur n'a pas sélectionné à temps.")
            .setColor(Colors.Error),
        ],
      });
    }

    // ══════════════ PHASE 3: BATTLE ══════════════

    const toCard = (inv: typeof invA, ids: string[]): DuelCard[] =>
      ids
        .map((id) => {
          const item = inv.find((i) => i.card.id === id);
          if (!item) return null;
          const c = item.card;
          return { ...c, beyblade: c.beyblade ?? '???' };
        })
        .filter(Boolean) as DuelCard[];

    const cardsA = toCard(invA, picksA).sort(
      (a, b) => cardSortPower(b) - cardSortPower(a),
    );
    const cardsB = toCard(invB, picksB).sort(
      (a, b) => cardSortPower(b) - cardSortPower(a),
    );

    if (cardsA.length < 3 || cardsB.length < 3) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setDescription('❌ Erreur lors de la résolution des cartes.')
            .setColor(Colors.Error),
        ],
      });
    }

    // Deduct bets
    if (bet > 0) {
      await Promise.all([
        this.prisma.profile.update({
          where: { userId: userA.id },
          data: { currency: { decrement: bet } },
        }),
        this.prisma.profile.update({
          where: { userId: userB.id },
          data: { currency: { decrement: bet } },
        }),
      ]);
    }

    // Calculate team bonuses
    const synergyA = hasSynergy(cardsA);
    const synergyB = hasSynergy(cardsB);
    const tpA = teamPower(cardsA);
    const tpB = teamPower(cardsB);
    const underdogA = tpA < tpB * 0.8; // 20%+ weaker
    const underdogB = tpB < tpA * 0.8;

    // Team bonus announcement
    const bonusLines: string[] = [];
    if (synergyA)
      bonusLines.push(`🔗 **${nameA}** active la **Synergie élémentaire** !`);
    if (synergyB)
      bonusLines.push(`🔗 **${nameB}** active la **Synergie élémentaire** !`);
    if (underdogA)
      bonusLines.push(`🔥 **${nameA}** obtient le bonus **Underdog** !`);
    if (underdogB)
      bonusLines.push(`🔥 **${nameB}** obtient le bonus **Underdog** !`);

    if (bonusLines.length > 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✨ Bonus activés !')
            .setDescription(bonusLines.join('\n'))
            .setColor(Colors.Secondary),
        ],
      });
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Play rounds
    const rounds: RoundResult[] = [];
    let scoreA = 0;
    let scoreB = 0;

    for (let i = 0; i < 3; i++) {
      const momentumA = i > 0 && rounds[i - 1]?.winner === 'A';
      const momentumB = i > 0 && rounds[i - 1]?.winner === 'B';
      const lastStandA = scoreA === 0 && scoreB === 1 && i === 2;
      const lastStandB = scoreB === 0 && scoreA === 1 && i === 2;

      const result = resolveRound(
        cardsA[i]!,
        cardsB[i]!,
        {
          synergy: synergyA,
          underdog: underdogA,
          momentum: momentumA,
          lastStand: lastStandA,
        },
        {
          synergy: synergyB,
          underdog: underdogB,
          momentum: momentumB,
          lastStand: lastStandB,
        },
      );
      rounds.push(result);
      if (result.winner === 'A') scoreA++;
      else scoreB++;

      const intro = randomPick(ROUND_INTROS[i]!);
      const winName = result.winner === 'A' ? nameA : nameB;
      const elA = ELEMENT_EMOJI[result.cardA.element] ?? '⚪';
      const elB = ELEMENT_EMOJI[result.cardB.element] ?? '⚪';
      const rarA = RARITY_EMOJI[result.cardA.rarity] ?? '⚪';
      const rarB = RARITY_EMOJI[result.cardB.rarity] ?? '⚪';
      const maxPwr = Math.max(result.powerA, result.powerB);

      const roundEmbed = new EmbedBuilder()
        .setTitle(`⚔️ Round ${i + 1} — ${intro}`)
        .addFields(
          {
            name: `${result.winner === 'A' ? '✅' : '❌'} ${nameA}`,
            value:
              `${rarA} **${result.cardA.name}**\n` +
              `${elA} ${ELEMENT_NAME[result.cardA.element] ?? 'Neutre'}\n` +
              `\`ATT ${result.cardA.att}\` · \`DEF ${result.cardA.def}\` · \`END ${result.cardA.end}\`\n` +
              `\`${powerBar(result.powerA, maxPwr)}\` **${Math.round(result.powerA)}**`,
            inline: true,
          },
          { name: '\u200b', value: '⚔️', inline: true },
          {
            name: `${result.winner === 'B' ? '✅' : '❌'} ${nameB}`,
            value:
              `${rarB} **${result.cardB.name}**\n` +
              `${elB} ${ELEMENT_NAME[result.cardB.element] ?? 'Neutre'}\n` +
              `\`ATT ${result.cardB.att}\` · \`DEF ${result.cardB.def}\` · \`END ${result.cardB.end}\`\n` +
              `**${Math.round(result.powerB)}** \`${powerBar(result.powerB, maxPwr)}\``,
            inline: true,
          },
        )
        .setColor(result.winner === 'A' ? 0x22c55e : 0xef4444);

      if (result.events.length > 0) {
        roundEmbed.addFields({
          name: '💥 Événements',
          value: result.events.join('\n'),
        });
      }

      roundEmbed
        .addFields({
          name: 'Résultat',
          value: `🏆 **${winName}** remporte le round !`,
        })
        .setFooter({ text: `Score : ${scoreA} — ${scoreB}` });

      await interaction.editReply({ embeds: [roundEmbed] });

      if (scoreA >= 2 || scoreB >= 2) break;
      await new Promise((r) => setTimeout(r, ROUND_DELAY));
    }

    // ══════════════ PHASE 4: RESULTS + ELO ══════════════

    const matchWinner = scoreA > scoreB ? 'A' : 'B';
    const winnerName = matchWinner === 'A' ? nameA : nameB;
    const loserName = matchWinner === 'A' ? nameB : nameA;
    const loserId = matchWinner === 'A' ? userB.id : userA.id;
    const winnerId = matchWinner === 'A' ? userA.id : userB.id;
    const winnerDiscordId =
      matchWinner === 'A' ? interaction.user.id : target.id;
    const loserDiscordId =
      matchWinner === 'A' ? target.id : interaction.user.id;

    // ELO
    const elo = calcElo(
      profileA.duelRating,
      profileB.duelRating,
      matchWinner === 'A',
    );
    const winnerEloD = matchWinner === 'A' ? elo.deltaA : elo.deltaB;
    const loserEloD = matchWinner === 'A' ? elo.deltaB : elo.deltaA;
    const winnerNewElo = matchWinner === 'A' ? elo.newA : elo.newB;

    // Streaks
    const winnerProfile = matchWinner === 'A' ? profileA : profileB;
    const newStreak = winnerProfile.duelStreak + 1;
    const newBestStreak = Math.max(winnerProfile.duelBestStreak, newStreak);

    // Finish type
    const avgRatio =
      rounds.reduce((sum, r) => {
        const w =
          r.winner === matchWinner
            ? matchWinner === 'A'
              ? r.powerA
              : r.powerB
            : matchWinner === 'A'
              ? r.powerB
              : r.powerA;
        const l =
          r.winner === matchWinner
            ? matchWinner === 'A'
              ? r.powerB
              : r.powerA
            : matchWinner === 'A'
              ? r.powerA
              : r.powerB;
        return sum + w / Math.max(l, 1);
      }, 0) / rounds.length;
    const finish = getFinish(avgRatio);

    // MVP card (biggest power margin)
    const mvpRound = [...rounds].sort((a, b) => b.mvpDelta - a.mvpDelta)[0]!;
    const mvpCard = mvpRound.winner === 'A' ? mvpRound.cardA : mvpRound.cardB;
    const mvpPlayer = mvpRound.winner === 'A' ? nameA : nameB;

    // Rewards
    const baseReward = Math.round(
      rounds.reduce((s, r) => s + Math.max(r.powerA, r.powerB), 0) / 4,
    );
    const streakBonus = newStreak >= 5 ? 50 : newStreak >= 3 ? 20 : 0;
    const totalReward =
      bet > 0 ? bet * 2 : Math.max(15, Math.min(baseReward, 200)) + streakBonus;
    const loserReward = bet > 0 ? 0 : 5;

    // Update DB
    await Promise.all([
      // Winner: coins + stats
      this.prisma.profile.update({
        where: { userId: winnerId },
        data: {
          currency: { increment: totalReward },
          duelWins: { increment: 1 },
          duelStreak: newStreak,
          duelBestStreak: newBestStreak,
          duelRating: winnerNewElo,
        },
      }),
      this.prisma.currencyTransaction.create({
        data: {
          userId: winnerId,
          amount: totalReward,
          type: 'DUEL_REWARD',
          note: `Duel victoire (${scoreA}-${scoreB}) — ${finish.msg}`,
        },
      }),
      // Loser: stats
      this.prisma.profile.update({
        where: { userId: loserId },
        data: {
          duelLosses: { increment: 1 },
          duelStreak: 0,
          duelRating: matchWinner === 'A' ? elo.newB : elo.newA,
        },
      }),
      ...(loserReward > 0
        ? [
            this.prisma.profile.update({
              where: { userId: loserId },
              data: { currency: { increment: loserReward } },
            }),
            this.prisma.currencyTransaction.create({
              data: {
                userId: loserId,
                amount: loserReward,
                type: 'DUEL_REWARD',
                note: 'Duel défaite (participation)',
              },
            }),
          ]
        : []),
    ]);

    // Save match
    const match = await this.prisma.duelMatch.create({
      data: {
        challengerId: interaction.user.id,
        opponentId: target.id,
        winnerId: winnerDiscordId,
        bet,
        score: `${scoreA}-${scoreB}`,
        finishType: finish.msg,
        rounds: rounds.map((r) => ({
          cardA: {
            name: r.cardA.name,
            rarity: r.cardA.rarity,
            element: r.cardA.element,
          },
          cardB: {
            name: r.cardB.name,
            rarity: r.cardB.rarity,
            element: r.cardB.element,
          },
          powerA: Math.round(r.powerA),
          powerB: Math.round(r.powerB),
          winner: r.winner,
          events: r.events,
        })),
      },
    });

    cooldowns.set(interaction.user.id, Date.now() + DUEL_COOLDOWN);
    cooldowns.set(target.id, Date.now() + DUEL_COOLDOWN);

    await new Promise((r) => setTimeout(r, 1500));

    // Canvas
    try {
      const { generateDuelArenaCard } = await import(
        '../../lib/canvas-utils.js'
      );
      const buffer = await generateDuelArenaCard({
        playerA: {
          name: nameA,
          avatarUrl: interaction.user.displayAvatarURL({
            extension: 'png',
            size: 128,
          }),
        },
        playerB: {
          name: nameB,
          avatarUrl: target.displayAvatarURL({ extension: 'png', size: 128 }),
        },
        rounds: rounds.map((r) => ({
          cardA: {
            name: r.cardA.name,
            rarity: r.cardA.rarity,
            element: r.cardA.element,
            imageUrl: r.cardA.imageUrl,
            power: Math.round(r.powerA),
            beyblade: r.cardA.beyblade,
          },
          cardB: {
            name: r.cardB.name,
            rarity: r.cardB.rarity,
            element: r.cardB.element,
            imageUrl: r.cardB.imageUrl,
            power: Math.round(r.powerB),
            beyblade: r.cardB.beyblade,
          },
          winner: r.winner,
          events: r.events,
        })),
        score: [scoreA, scoreB],
        winner: matchWinner,
        bet,
        coinReward: totalReward,
        finishMessage: finish.msg,
        matchId: match.id.slice(-8),
      });
      await interaction.editReply({
        embeds: [],
        files: [new AttachmentBuilder(buffer, { name: 'duel-arena.png' })],
        components: [],
      });
    } catch (err) {
      logger.error('[Duel] Canvas failed:', err);
    }

    // Summary + Revenge button
    const summaryLines = rounds.map((r, i) => {
      const w = r.winner === 'A' ? '🟢' : '🔴';
      return `**R${i + 1}** ${w} ${r.cardA.name} (**${Math.round(r.powerA)}**) vs ${r.cardB.name} (**${Math.round(r.powerB)}**)`;
    });

    const winnerTier = getRankTier(winnerNewElo);
    const eloLine = `📊 ELO : **${winnerName}** ${winnerEloD > 0 ? '+' : ''}${winnerEloD} (${winnerNewElo} ${winnerTier.emoji}) · **${loserName}** ${loserEloD > 0 ? '+' : ''}${loserEloD}`;
    const streakLine =
      newStreak >= 3
        ? `\n🔥 **${winnerName}** est en série de ${newStreak} victoires !`
        : '';
    const mvpLine = `\n⭐ **MVP :** ${mvpCard.name} (${mvpPlayer}) — marge de +${Math.round(mvpRound.mvpDelta)} PWR`;

    const revengeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`duel-revenge-${loserDiscordId}-${winnerDiscordId}-${bet}`)
        .setLabel('🔄 Revanche !')
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.followUp({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${finish.emoji} ${finish.msg}`)
          .setDescription(
            `🏆 **${winnerName}** remporte le duel ! (**${scoreA}**—**${scoreB}**)\n\n` +
              summaryLines.join('\n') +
              '\n\n' +
              `💰 **+${totalReward} 🪙** pour ${winnerName}` +
              (streakBonus > 0 ? ` (dont +${streakBonus} bonus série)` : '') +
              (loserReward > 0 ? ` · +${loserReward} 🪙 participation` : '') +
              (bet > 0 ? `\n🎰 Mise : ${bet} 🪙 chacun` : '') +
              '\n' +
              eloLine +
              streakLine +
              mvpLine,
          )
          .setColor(finish.color)
          .setFooter({ text: `Match #${match.id.slice(-8)} · ${RPB.Name}` })
          .setTimestamp(),
      ],
      components: [revengeRow],
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Revenge button handler
  // ══════════════════════════════════════════════════════════════════════════════

  @ButtonComponent({ id: /^duel-revenge-/ })
  async handleRevenge(interaction: ButtonInteraction) {
    const parts = interaction.customId.split('-');
    const loserId = parts[2]!;
    const winnerId = parts[3]!;
    const bet = Number.parseInt(parts[4] ?? '0', 10);

    if (interaction.user.id !== loserId) {
      return interaction.reply({
        content: '❌ Seul le perdant peut demander la revanche !',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Disable the button
    await interaction.update({ components: [] });

    // Send a new challenge message
    const winner = await interaction.client.users.fetch(winnerId);
    await interaction.followUp(
      `⚔️ **${interaction.user.displayName}** demande la revanche à **${winner.displayName}** !\n` +
        `> Utilise \`/duel combat adversaire:@${winner.displayName}${bet > 0 ? ` mise:${bet}` : ''}\` pour relancer !`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /duel stats — Player duel statistics
  // ══════════════════════════════════════════════════════════════════════════════

  @Slash({
    name: 'stats',
    description: "📊 Voir les statistiques de duel d'un joueur",
  })
  @SlashGroup('duel')
  async stats(
    @SlashOption({
      name: 'joueur',
      description: 'Le joueur (toi par défaut)',
      required: false,
      type: ApplicationCommandOptionType.User,
    })
    targetUser: User | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const target = targetUser ?? interaction.user;
    const user = await this.prisma.user.findUnique({
      where: { discordId: target.id },
      include: { profile: true },
    });

    if (!user?.profile) {
      return interaction.editReply("❌ Ce joueur n'a pas de profil.");
    }

    const p = user.profile;
    const tier = getRankTier(p.duelRating);
    const total = p.duelWins + p.duelLosses;
    const winRate = total > 0 ? Math.round((p.duelWins / total) * 100) : 0;

    // Fetch recent matches
    const recentMatches = await this.prisma.duelMatch.findMany({
      where: { OR: [{ challengerId: target.id }, { opponentId: target.id }] },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    const recentLines = recentMatches.map((m) => {
      const won = m.winnerId === target.id;
      const opponent =
        m.challengerId === target.id ? m.opponentId : m.challengerId;
      const date = `<t:${Math.floor(m.createdAt.getTime() / 1000)}:R>`;
      return `${won ? '🟢' : '🔴'} **${m.score}** vs <@${opponent}> · ${m.finishType} ${date}`;
    });

    // Most used element in duels
    const allMatches = await this.prisma.duelMatch.findMany({
      where: { OR: [{ challengerId: target.id }, { opponentId: target.id }] },
      select: { rounds: true, challengerId: true },
    });

    const elementCounts: Record<string, number> = {};
    for (const m of allMatches) {
      const roundsData = m.rounds as Array<{
        cardA: { element: string };
        cardB: { element: string };
      }>;
      for (const r of roundsData) {
        const el =
          m.challengerId === target.id ? r.cardA?.element : r.cardB?.element;
        if (el) elementCounts[el] = (elementCounts[el] ?? 0) + 1;
      }
    }
    const favElement = Object.entries(elementCounts).sort(
      (a, b) => b[1] - a[1],
    )[0];

    const embed = new EmbedBuilder()
      .setTitle(`${tier.emoji} Stats de Duel — ${target.displayName}`)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .setColor(Number.parseInt(tier.color.replace('#', ''), 16))
      .addFields(
        {
          name: '🏅 Rang',
          value: `**${tier.name}** (${p.duelRating} ELO)`,
          inline: true,
        },
        {
          name: '📊 W/L',
          value: `**${p.duelWins}**V / **${p.duelLosses}**D (${winRate}%)`,
          inline: true,
        },
        {
          name: '🔥 Série',
          value: `Actuelle : **${p.duelStreak}** · Record : **${p.duelBestStreak}**`,
          inline: true,
        },
        { name: '🎯 Duels joués', value: `**${total}**`, inline: true },
        {
          name: '💫 Élément favori',
          value: favElement
            ? `${ELEMENT_EMOJI[favElement[0]] ?? '⚪'} ${ELEMENT_NAME[favElement[0]] ?? favElement[0]} (${favElement[1]}×)`
            : 'Aucun',
          inline: true,
        },
      );

    if (recentLines.length > 0) {
      embed.addFields({
        name: '📜 Derniers matchs',
        value: recentLines.join('\n'),
      });
    }

    embed.setFooter({ text: RPB.Name }).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /duel classement — Leaderboard
  // ══════════════════════════════════════════════════════════════════════════════

  @Slash({
    name: 'classement',
    description: '🏆 Top 10 des duellistes par ELO',
  })
  @SlashGroup('duel')
  async leaderboard(interaction: CommandInteraction) {
    await interaction.deferReply();

    const top = await this.prisma.profile.findMany({
      where: { duelWins: { gt: 0 } },
      orderBy: { duelRating: 'desc' },
      take: 10,
      include: { user: { select: { discordId: true, name: true } } },
    });

    if (top.length === 0) {
      return interaction.editReply("Aucun duel joué pour l'instant !");
    }

    const lines = top.map((p, i) => {
      const rank =
        i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
      const tier = getRankTier(p.duelRating);
      const total = p.duelWins + p.duelLosses;
      const wr = total > 0 ? Math.round((p.duelWins / total) * 100) : 0;
      const name = p.user.discordId
        ? `<@${p.user.discordId}>`
        : (p.user.name ?? 'Inconnu');
      const streak = p.duelStreak >= 3 ? ` 🔥${p.duelStreak}` : '';
      return `${rank} ${tier.emoji} ${name} — **${p.duelRating}** ELO · ${p.duelWins}V/${p.duelLosses}D (${wr}%)${streak}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🏆 Classement des Duellistes')
      .setDescription(lines.join('\n'))
      .setColor(Colors.Secondary)
      .setFooter({ text: `${top.length} duellistes classés · ${RPB.Name}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /duel historique — Recent matches
  // ══════════════════════════════════════════════════════════════════════════════

  @Slash({
    name: 'historique',
    description: '📜 Voir les 10 derniers duels du serveur',
  })
  @SlashGroup('duel')
  async history(interaction: CommandInteraction) {
    await interaction.deferReply();

    const matches = await this.prisma.duelMatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (matches.length === 0) {
      return interaction.editReply("Aucun duel joué pour l'instant !");
    }

    const lines = matches.map((m) => {
      const date = `<t:${Math.floor(m.createdAt.getTime() / 1000)}:R>`;
      const winner =
        m.winnerId === m.challengerId ? m.challengerId : m.opponentId;
      const loser =
        m.winnerId === m.challengerId ? m.opponentId : m.challengerId;
      const betStr = m.bet > 0 ? ` · 🎰 ${m.bet} 🪙` : '';
      return `${m.finishType.split(' ')[0]} <@${winner}> **${m.score}** <@${loser}>${betStr} ${date}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('📜 Historique des Duels')
      .setDescription(lines.join('\n'))
      .setColor(Colors.Info)
      .setFooter({ text: RPB.Name })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }
}
