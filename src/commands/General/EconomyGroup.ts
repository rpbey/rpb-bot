import { ApplicationCommandOptionType, AttachmentBuilder, EmbedBuilder, MessageFlags, type CommandInteraction } from "discord.js";
import { Discord, Guard, Slash, SlashGroup, SlashOption } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { StaffOnly } from '../../guards/StaffOnly.js';
import {
  generateCollectionCard,
  generateEconomyProfileCard,
  generateGachaCard,
  generateGachaLeaderboardCard,
  generateGachaMissCard,
} from '../../lib/canvas-utils.js';
import { Colors, RPB } from '../../lib/constants.js';
import { PrismaService } from '../../lib/prisma.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const GACHA_COST = 50;
const MULTI_PULL_COUNT = 10;
const MULTI_PULL_COST = GACHA_COST * MULTI_PULL_COUNT - 50; // 450

const DAILY_TIERS = [
  {
    weight: 60,
    min: 80,
    max: 120,
    msg: '+**{n}** pièces ajoutées à ta collection !',
  },
  { weight: 25, min: 150, max: 200, msg: 'Beau tirage ! +**{n}** pièces !' },
  {
    weight: 10,
    min: 250,
    max: 350,
    msg: 'Excellent ! Une vraie pépite ! +**{n}** pièces !',
  },
  {
    weight: 4,
    min: 500,
    max: 700,
    msg: '🌟 Incroyable ! Un trésor ultra-rare ! +**{n}** pièces !',
  },
  {
    weight: 1,
    min: 1000,
    max: 1500,
    msg: '💎✨ JACKPOT LÉGENDAIRE !!! +**{n}** pièces !!!',
  },
] as const;

const STREAK_BONUSES = [
  { days: 3, bonus: 50, label: '3 jours' },
  { days: 7, bonus: 150, label: '1 semaine' },
  { days: 14, bonus: 300, label: '2 semaines' },
  { days: 30, bonus: 750, label: '1 mois' },
] as const;

const BADGES = [
  { count: 5, reward: 200, name: 'Débutant', emoji: '🥉' },
  { count: 10, reward: 500, name: 'Collectionneur', emoji: '🥈' },
  { count: 15, reward: 750, name: 'Expert', emoji: '🥇' },
  { count: 20, reward: 1000, name: 'Maître', emoji: '🏆' },
  { count: 25, reward: 1500, name: 'Champion', emoji: '👑' },
  { count: 31, reward: 3000, name: 'Légende (100%)', emoji: '⭐' },
] as const;

// Drop 1 = 32 cartes: 16 Commun, 10 Rare, 4 Super Rare, 2 Légendaire
const RARITY_RATES = {
  MISS: 0.3,
  COMMON: 0.35, // 16/32 cartes
  RARE: 0.22, // 10/32 cartes
  SUPER_RARE: 0.1, // 4/32 cartes
  LEGENDARY: 0.03, // 2/32 cartes
} as const;

const RARITY_CONFIG: Record<
  string,
  { emoji: string; color: number; label: string; sellPrice: number }
> = {
  COMMON: { emoji: '⚪', color: 0x9ca3af, label: 'Commune', sellPrice: 5 },
  RARE: { emoji: '🔵', color: 0x3b82f6, label: 'Rare', sellPrice: 15 },
  SUPER_RARE: {
    emoji: '🟣',
    color: 0x8b5cf6,
    label: 'Super Rare',
    sellPrice: 50,
  },
  LEGENDARY: {
    emoji: '🟡',
    color: 0xfbbf24,
    label: 'Légendaire',
    sellPrice: 150,
  },
  // Legacy — keep for old cards still in DB
  SECRET: { emoji: '🔴', color: 0xef4444, label: 'Secrète', sellPrice: 500 },
};

const MISS_MESSAGES = [
  "La toupie s'est éjectée du stadium... Tu n'as rien obtenu !",
  'Burst ! Ta toupie a explosé avant le tirage... Raté !',
  "Le Bey Spirit n'était pas avec toi cette fois...",
  "Tu as lancé trop faible... La toupie s'est arrêtée.",
  "Un Ring Out ! Tu n'as attrapé aucune carte.",
  'Doji a volé ta carte avant que tu ne la voies...',
  'La Dark Nebula a intercepté ton tirage !',
  "Storm Pegasus t'a repoussé hors du stadium...",
  'L-Drago a absorbé toute ton énergie de tirage...',
];

// Pity system: after PITY_THRESHOLD consecutive misses, guarantee at least COMMON
const PITY_THRESHOLD = 3;

// Element advantage map: attacker element → defender elements it beats (×1.25 damage)
const ELEMENT_ADVANTAGE: Record<string, string[]> = {
  FEU: ['VENT'],
  VENT: ['TERRE'],
  TERRE: ['EAU'],
  EAU: ['FEU'],
  OMBRE: ['LUMIERE'],
  LUMIERE: ['OMBRE'],
};

// Gift cooldown: 1 gift per 12 hours per recipient
const GIFT_COOLDOWN_MS = 12 * 3_600_000;

type CardRarityType = 'COMMON' | 'RARE' | 'SUPER_RARE' | 'LEGENDARY' | 'SECRET';

interface UserProfile {
  userId: string; // Internal DB user ID
  profile: {
    id: string;
    currency: number;
    lastDaily: Date | null;
    dailyStreak: number;
    pityCount: number;
    lastGiftSent: Date | null;
  };
}

interface PullResult {
  rarity: CardRarityType | null;
  card: {
    name: string;
    nameJp: string | null;
    series: string;
    description: string | null;
    beyblade: string | null;
    imageUrl: string | null;
    id: string;
    att: number;
    def: number;
    end: number;
    equilibre: number;
    element: string;
    specialMove: string | null;
  } | null;
  isDuplicate: boolean;
  isWished: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rollRarity(): CardRarityType | null {
  const roll = Math.random();
  let cum = 0;
  cum += RARITY_RATES.MISS;
  if (roll < cum) return null;
  cum += RARITY_RATES.COMMON;
  if (roll < cum) return 'COMMON';
  cum += RARITY_RATES.RARE;
  if (roll < cum) return 'RARE';
  cum += RARITY_RATES.SUPER_RARE;
  if (roll < cum) return 'SUPER_RARE';
  cum += RARITY_RATES.LEGENDARY;
  if (roll < cum) return 'LEGENDARY';
  return 'LEGENDARY'; // Fallback to highest
}

function rollDaily(): { amount: number; msg: string; tier: number } {
  const totalWeight = DAILY_TIERS.reduce((s, t) => s + t.weight, 0);
  let roll = Math.random() * totalWeight;
  for (let i = 0; i < DAILY_TIERS.length; i++) {
    const t = DAILY_TIERS[i]!;
    roll -= t.weight;
    if (roll <= 0) {
      const amount = Math.floor(Math.random() * (t.max - t.min + 1)) + t.min;
      return {
        amount,
        msg: t.msg.replace('{n}', amount.toLocaleString('fr-FR')),
        tier: i,
      };
    }
  }
  return { amount: 100, msg: '+**100** pièces !', tier: 0 };
}

function randomMiss(): string {
  return MISS_MESSAGES[Math.floor(Math.random() * MISS_MESSAGES.length)]!;
}

// ─── Command Group ──────────────────────────────────────────────────────────

@Discord()
@SlashGroup({
  name: 'gacha',
  description: 'Système de cartes à collectionner RPB',
})
@SlashGroup('gacha')
@Guard(StaffOnly)
@injectable()
export class EconomyGroup {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  /** Resolve Discord user → DB User → Profile */
  private async resolve(interaction: CommandInteraction): Promise<UserProfile> {
    const discordId = interaction.user.id;
    const displayName = interaction.user.displayName;

    let user = await this.prisma.user.findUnique({ where: { discordId } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          discordId,
          name: displayName,
          email: `${discordId}@discord.rpbey.fr`,
        },
      });
    }

    let profile = await this.prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      profile = await this.prisma.profile.create({
        data: { userId: user.id, currency: 0 },
      });
    }

    return { userId: user.id, profile };
  }

  private debtEmbed(profile: { currency: number }): EmbedBuilder | null {
    if (profile.currency >= 0) return null;
    const debt = Math.abs(profile.currency);
    const interest = Math.round(debt * 0.15);
    return new EmbedBuilder()
      .setColor(0x991b1b)
      .setTitle('🏦 Recouvrement de dette')
      .setDescription(
        `Tu as une dette de **${debt.toLocaleString('fr-FR')}** 🪙 !\nIntérêts quotidiens : **${interest.toLocaleString('fr-FR')}** 🪙 (15%)\n\n` +
          '**Commandes bloquées** : gacha, multi, parier\n\n' +
          '💡 Pour rembourser :\n> `/gacha daily` · `/gacha vendre-tout` · `/jeu combat` · `/gacha duel`',
      )
      .setFooter({
        text: "Rembourse pour débloquer les tirages ! · /gacha dette pour plus d'infos",
      });
  }

  private async checkBadges(
    userId: string,
    profileId: string,
  ): Promise<string | null> {
    const uniqueCount = await this.prisma.cardInventory.count({
      where: { userId },
    });
    for (const badge of BADGES) {
      if (uniqueCount >= badge.count) {
        const existing = await this.prisma.currencyTransaction.findFirst({
          where: { userId, type: 'BADGE_REWARD', note: `Badge: ${badge.name}` },
        });
        if (!existing) {
          await this.prisma.profile.update({
            where: { id: profileId },
            data: { currency: { increment: badge.reward } },
          });
          await this.prisma.currencyTransaction.create({
            data: {
              userId,
              amount: badge.reward,
              type: 'BADGE_REWARD',
              note: `Badge: ${badge.name}`,
            },
          });
          return `${badge.emoji} **Badge "${badge.name}" débloqué !** +${badge.reward} 🪙`;
        }
      }
    }
    return null;
  }

  private async pullCard(
    userId: string,
    profileId: string,
  ): Promise<PullResult> {
    // Check pity counter
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { pityCount: true },
    });
    const currentPity = profile?.pityCount ?? 0;

    let rarity = rollRarity();

    // Pity system: after PITY_THRESHOLD consecutive misses, guarantee at least COMMON
    if (!rarity && currentPity >= PITY_THRESHOLD - 1) {
      rarity = 'COMMON';
    }

    if (!rarity) {
      // Increment pity counter
      await this.prisma.profile.update({
        where: { id: profileId },
        data: { pityCount: { increment: 1 } },
      });
      return { rarity: null, card: null, isDuplicate: false, isWished: false };
    }

    // Reset pity counter on successful pull
    await this.prisma.profile.update({
      where: { id: profileId },
      data: { pityCount: 0 },
    });

    // Prefer cards from active drop, fallback to all active cards
    const activeDrop = await this.prisma.gachaDrop.findFirst({
      where: { isActive: true },
    });
    let cards = await this.prisma.gachaCard.findMany({
      where: {
        rarity,
        isActive: true,
        ...(activeDrop ? { dropId: activeDrop.id } : {}),
      },
    });
    // Fallback: if no cards of this rarity in active drop, try all drop cards
    if (cards.length === 0 && activeDrop) {
      cards = await this.prisma.gachaCard.findMany({
        where: { isActive: true, dropId: activeDrop.id },
      });
    }
    // Final fallback: any active card of this rarity
    if (cards.length === 0) {
      cards = await this.prisma.gachaCard.findMany({
        where: { rarity, isActive: true },
      });
    }
    if (cards.length === 0)
      return { rarity, card: null, isDuplicate: false, isWished: false };

    const card = cards[Math.floor(Math.random() * cards.length)]!;
    await this.prisma.cardInventory.upsert({
      where: { userId_cardId: { userId, cardId: card.id } },
      create: { userId, cardId: card.id, count: 1 },
      update: { count: { increment: 1 } },
    });

    const inv = await this.prisma.cardInventory.findUnique({
      where: { userId_cardId: { userId, cardId: card.id } },
    });
    const isDuplicate = inv ? inv.count > 1 : false;
    const isWished = !!(await this.prisma.cardWishlist.findUnique({
      where: { profileId_cardId: { profileId, cardId: card.id } },
    }));

    return { rarity, card, isDuplicate, isWished };
  }

  private buildPullEmbed(result: PullResult, balance: number): EmbedBuilder {
    if (!result.card || !result.rarity) {
      return new EmbedBuilder()
        .setColor(0x4b5563)
        .setTitle('💨 Raté !')
        .setDescription(
          `${randomMiss()}\n\n💰 Solde : **${balance.toLocaleString('fr-FR')}** 🪙`,
        )
        .setFooter({ text: 'Retente ta chance !' });
    }
    const cfg = RARITY_CONFIG[result.rarity]!;
    let title = `${cfg.emoji} Carte ${cfg.label} obtenue !`;
    if (result.rarity === 'SECRET') title = '✨🔴 CARTE SECRÈTE !!! 🔴✨';
    else if (result.rarity === 'LEGENDARY')
      title = '⭐🟡 Carte LÉGENDAIRE ! 🟡⭐';

    const embed = new EmbedBuilder()
      .setColor(result.isWished ? 0xfbbf24 : cfg.color)
      .setTitle(result.isWished ? `⭐ ${title}` : title)
      .setDescription(
        `**${result.card.name}**${result.card.nameJp ? ` (${result.card.nameJp})` : ''}\n${result.card.series.replace(/_/g, ' ')}\n\n${result.card.description || ''}` +
          (result.card.beyblade
            ? `\n\n🌀 **Toupie :** ${result.card.beyblade}`
            : '') +
          (result.isWished ? '\n\n⭐ **CARTE SOUHAITÉE !**' : '') +
          (result.isDuplicate ? '\n📋 *Doublon — `/gacha vendre`*' : ''),
      )
      .setFooter({ text: `💰 Solde : ${balance.toLocaleString('fr-FR')} 🪙` });
    if (result.card.imageUrl) embed.setThumbnail(result.card.imageUrl);
    return embed;
  }

  // ═══ /gacha aide ═══
  @Slash({ name: 'aide', description: 'Guide complet du système gacha TCG' })
  async help(interaction: CommandInteraction) {
    const totalCards = await this.prisma.gachaCard.count({
      where: { isActive: true },
    });

    const embed1 = new EmbedBuilder()
      .setColor(RPB.Color)
      .setTitle('🎰 Guide du Gacha TCG — RPB')
      .setDescription(
        `Collectionne **${totalCards} cartes** de bladers légendaires de toutes les générations Beyblade !\nChaque carte a des **stats de combat** (ATT/DEF/END/ÉQU) et un **élément**.`,
      )
      .addFields(
        {
          name: '🪙 Gagner des pièces',
          value: [
            '`/gacha daily` — Récompense toutes les **20h** (5 tiers)',
            '> 60%: 80-120🪙 · 25%: 150-200🪙 · 10%: 250-350🪙',
            '> 4%: 500-700🪙 ⭐ · **1%: 1000-1500🪙 💎**',
            '`/gacha vendre` — Vends 1 doublon (⚪5 · 🔵15 · 🟣50 · 🟡150 · 🔴500)',
            "`/gacha vendre-tout` — Vends **tous** tes doublons d'un coup",
            '`/jeu combat @user` — Gagne 10-30🪙 par victoire',
          ].join('\n'),
        },
        {
          name: '🔥 Streak quotidien',
          value:
            '**3j** +50🪙 · **7j** +150🪙 · **14j** +300🪙 · **30j** +750🪙\n⚠️ >48h sans daily = streak reset · Découvert max : **-1 000🪙**',
        },
      );

    const embed2 = new EmbedBuilder().setColor(RPB.GoldColor).addFields(
      {
        name: '🃏 Tirer des cartes',
        value: [
          '`/gacha gacha` — Tirage unique (**50🪙**)',
          '`/gacha multi` — Tirage x10 (**450🪙**, économie 10%)',
          '',
          '**Taux :**  💨 Raté **30%** · ⚪ **35%** · 🔵 **22%** · 🟣 **10%** · 🟡 **3%**',
          '**Pity :** Carte garantie après **3 ratés** consécutifs',
        ].join('\n'),
      },
      {
        name: '⚔️ Combat de cartes',
        value: [
          "`/gacha duel @user` — Tes cartes s'affrontent !",
          '> Pioche aléatoire depuis ta collection',
          '> Puissance = **vrais stats** (ATT/DEF/END/ÉQU) + rareté + éléments',
          '> Avantages élémentaires ×1.25 (🔥>🌪️>🌍>💧>🔥)',
          '> Le gagnant remporte des 🪙',
        ].join('\n'),
      },
      {
        name: '⭐ Wishlist & Gestion',
        value: [
          '`/gacha wish <nom>` — Ajoute/retire de ta wishlist',
          '`/gacha wishlist` — Tes cartes souhaitées (✅ = obtenues)',
          '> Embed **doré** spécial quand tu drop une carte souhaitée !',
        ].join('\n'),
      },
    );

    const embed3 = new EmbedBuilder().setColor(0x3b82f6).addFields(
      {
        name: '🌀 Éléments & Avantages (×1.25 dégâts)',
        value: [
          '🔥 **Feu** > 🌪️ **Vent** > 🌍 **Terre** > 💧 **Eau** > 🔥 **Feu**',
          '🌑 **Ombre** ⟷ ✨ **Lumière** (mutuellement forts)',
          "⚪ **Neutre** = pas d'avantage",
        ].join('\n'),
      },
      {
        name: '📊 Stats des cartes',
        value: [
          '**ATT** — Dégâts infligés en combat',
          '**DEF** — Réduction des dégâts reçus',
          '**END** — Endurance et résistance prolongée',
          '**ÉQU** — Équilibre global du blader',
          '',
          '> Stats basées sur la rareté + archétype du personnage',
        ].join('\n'),
      },
    );

    const embed4 = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .addFields(
        {
          name: '📖 Commandes',
          value: [
            '`/gacha solde` — Profil complet (pièces, streak, collection, badge)',
            '`/gacha collection` — Tes cartes en image canvas',
            '`/gacha catalogue [série]` — Toutes les cartes (✅/⬛ possédées)',
            '`/gacha voir <nom>` — Affiche une carte en détail avec image HD',
            '`/gacha classement` — Top collectionneurs + top fortunes',
            '`/gacha drop` — Info sur le drop actif et ta progression',
            '`/gacha donner @user <montant>` — Donne des pièces (12h cooldown)',
            '`/gacha echange @user <ta-carte> <sa-carte>` — Échange de cartes',
            '`/gacha taux` — Tableau des mécaniques',
            '`/gacha admin-give @user <montant>` — [ADMIN] Donner/retirer des 🪙',
          ].join('\n'),
        },
        {
          name: '🏅 Badges de collection',
          value:
            '🥉 5 cartes +200🪙 · 🥈 10 +500🪙 · 🥇 15 +750🪙\n🏆 20 +1000🪙 · 👑 25 +1500🪙 · ⭐ Légende (tout) +3000🪙',
        },
        {
          name: `📦 ${totalCards} cartes · 7 séries`,
          value: [
            '**Bakuten** (Original) · **Metal Fusion** · **Metal Masters**',
            '**Metal Fury** · **Shogun Steel** · **Burst** · **Beyblade X**',
            '',
            '🔴 4 Secrètes · 🟡 12 Légendaires · 🟣 21 Épiques · 🔵 17 Rares · ⚪ 28 Communes',
          ].join('\n'),
        },
      )
      .setFooter({
        text: 'RPB Gacha TCG — Collectionne, combats, domine ! 🌀',
      });

    return interaction.reply({ embeds: [embed1, embed2, embed3, embed4] });
  }

  // ═══ /gacha daily ═══
  @Slash({ name: 'daily', description: 'Réclame tes pièces quotidiennes' })
  async daily(interaction: CommandInteraction) {
    await interaction.deferReply();
    const { userId, profile } = await this.resolve(interaction);
    const now = new Date();

    if (profile.lastDaily) {
      const hoursLeft =
        20 - (now.getTime() - profile.lastDaily.getTime()) / 3_600_000;
      if (hoursLeft > 0) {
        const h = Math.floor(hoursLeft);
        const m = Math.floor((hoursLeft - h) * 60);
        const nextTimestamp = Math.floor(
          (profile.lastDaily.getTime() + 20 * 3_600_000) / 1000,
        );
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Warning)
              .setTitle('⏳ Trop tôt !')
              .setDescription(
                `Reviens dans **${h}h ${m}min** (<t:${nextTimestamp}:R>)`,
              )
              .addFields(
                {
                  name: '🔥 Streak actuel',
                  value: `**${profile.dailyStreak}** jour${profile.dailyStreak > 1 ? 's' : ''}`,
                  inline: true,
                },
                {
                  name: '💰 Solde',
                  value: `**${profile.currency.toLocaleString('fr-FR')}** 🪙`,
                  inline: true,
                },
              )
              .setFooter({ text: 'Ne casse pas ton streak !' }),
          ],
        });
      }
    }

    let newStreak = 1;
    if (
      profile.lastDaily &&
      (now.getTime() - profile.lastDaily.getTime()) / 3_600_000 < 48
    ) {
      newStreak = profile.dailyStreak + 1;
    }
    const streakBroken =
      profile.lastDaily && profile.dailyStreak > 0 && newStreak === 1;

    const { amount, msg, tier } = rollDaily();
    let streakBonus = 0;
    let streakBonusLabel = '';
    for (const sb of STREAK_BONUSES) {
      if (newStreak === sb.days) {
        streakBonus = sb.bonus;
        streakBonusLabel = sb.label;
        break;
      }
    }

    // Debt interest: 15% of debt deducted from daily reward → sent to banker Yoyo
    const BANKER_DISCORD_ID = '281114294152724491'; // Yoyo (Yoyo__goat)
    const INTEREST_RATE = 0.15; // 15%
    let interestPaid = 0;
    let totalGain = amount + streakBonus;
    if (profile.currency < 0) {
      interestPaid = Math.round(Math.abs(profile.currency) * INTEREST_RATE);
      totalGain = Math.max(1, totalGain - interestPaid);

      // Transfer interest to banker
      if (interestPaid > 0) {
        const banker = await this.prisma.user.findUnique({
          where: { discordId: BANKER_DISCORD_ID },
        });
        if (banker) {
          await this.prisma.profile.upsert({
            where: { userId: banker.id },
            update: { currency: { increment: interestPaid } },
            create: { userId: banker.id, currency: interestPaid },
          });
          await this.prisma.currencyTransaction.create({
            data: {
              userId: banker.id,
              amount: interestPaid,
              type: 'ADMIN_GIVE',
              note: `Intérêts dette de ${interaction.user.displayName}`,
            },
          });
        }
      }
    }

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: {
        currency: { increment: totalGain },
        lastDaily: now,
        dailyStreak: newStreak,
      },
    });
    await this.prisma.currencyTransaction.create({
      data: {
        userId,
        amount: totalGain,
        type: 'DAILY_CLAIM',
        note: `Tier ${tier + 1} — Streak ${newStreak}${interestPaid > 0 ? ` — Intérêts: -${interestPaid} → Banquier` : ''}`,
      },
    });
    if (streakBonus > 0)
      await this.prisma.currencyTransaction.create({
        data: {
          userId,
          amount: streakBonus,
          type: 'STREAK_BONUS',
          note: `Streak ${newStreak}j`,
        },
      });

    const tierEmojis = ['🪙', '✨', '💫', '🌟', '💎'];
    const tierColors = [
      Colors.Info,
      Colors.Success,
      Colors.Warning,
      0xfbbf24,
      0xef4444,
    ];
    const tierLabels = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4 ⭐', 'Tier 5 💎'];
    const newBalance = profile.currency + totalGain;
    const streakBar =
      '🔥'.repeat(Math.min(newStreak, 10)) +
      (newStreak > 10 ? ` ×${newStreak}` : '');
    const nextStreakBonus = STREAK_BONUSES.find((s) => s.days > newStreak);

    const embed = new EmbedBuilder()
      .setColor(tierColors[tier] ?? Colors.Info)
      .setTitle(
        `${tierEmojis[tier]} ${tier >= 3 ? 'DAILY EXCEPTIONNEL !' : 'Récompense quotidienne'}`,
      )
      .setDescription(msg)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        {
          name: '💰 Solde',
          value: `**${newBalance.toLocaleString('fr-FR')}** 🪙`,
          inline: true,
        },
        { name: '🎲 Tier', value: tierLabels[tier] || 'Tier 1', inline: true },
        {
          name: '🔥 Streak',
          value: `${streakBar}\n**${newStreak}** jour${newStreak > 1 ? 's' : ''}`,
          inline: false,
        },
      );

    if (streakBonus > 0) {
      embed.addFields({
        name: `🎁 Bonus streak ${streakBonusLabel} !`,
        value: `+**${streakBonus}** 🪙 bonus`,
        inline: true,
      });
    }
    if (interestPaid > 0) {
      embed.addFields({
        name: '🏦 Intérêts dette (15%)',
        value: `**-${interestPaid}** 🪙 prélevés sur ta récompense`,
        inline: true,
      });
    }
    if (streakBroken) {
      embed.addFields({
        name: '💔 Streak perdu',
        value: `Ton streak de **${profile.dailyStreak}** jours a été réinitialisé.`,
        inline: false,
      });
    }
    if (nextStreakBonus) {
      embed.setFooter({
        text: `Prochain bonus streak : ${nextStreakBonus.label} (dans ${nextStreakBonus.days - newStreak}j) · Prochain daily : 20h`,
      });
    } else {
      embed.setFooter({ text: 'Streak max atteint ! · Prochain daily : 20h' });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // ═══ /gacha solde ═══
  @Slash({ name: 'solde', description: 'Affiche ton profil économie' })
  async balance(interaction: CommandInteraction) {
    const { userId, profile } = await this.resolve(interaction);
    const [
      uniqueCards,
      totalCopies,
      totalCards,
      wishCount,
      dupeCount,
      totalSpent,
    ] = await Promise.all([
      this.prisma.cardInventory.count({ where: { userId } }),
      this.prisma.cardInventory.aggregate({
        where: { userId },
        _sum: { count: true },
      }),
      this.prisma.gachaCard.count({ where: { isActive: true } }),
      this.prisma.cardWishlist.count({ where: { profileId: profile.id } }),
      this.prisma.cardInventory.count({ where: { userId, count: { gt: 1 } } }),
      this.prisma.currencyTransaction.aggregate({
        where: { userId, amount: { lt: 0 } },
        _sum: { amount: true },
      }),
    ]);

    const pct =
      totalCards > 0 ? Math.round((uniqueCards / totalCards) * 100) : 0;
    const _bar =
      '▓'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));

    let currentBadge = '';
    for (const b of [...BADGES].reverse()) {
      if (uniqueCards >= b.count) {
        currentBadge = `${b.emoji} ${b.name}`;
        break;
      }
    }
    const nextBadge = BADGES.find((b) => b.count > uniqueCards);

    // Rarity breakdown
    const byRarity = await this.prisma.cardInventory.findMany({
      where: { userId },
      include: { card: { select: { rarity: true } } },
    });
    const rarityCount: Record<string, number> = {};
    for (const inv of byRarity) {
      rarityCount[inv.card.rarity] = (rarityCount[inv.card.rarity] || 0) + 1;
    }
    const rarityBreakdown = [
      'SECRET',
      'LEGENDARY',
      'SUPER_RARE',
      'RARE',
      'COMMON',
    ]
      .filter((r) => rarityCount[r])
      .map((r) => ({
        rarity: r,
        count: rarityCount[r] || 0,
        emoji: RARITY_CONFIG[r]?.emoji || '⚪',
      }));

    const spent = Math.abs(totalSpent._sum.amount || 0);

    const buffer = await generateEconomyProfileCard({
      name: interaction.user.displayName,
      avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
      currency: profile.currency,
      streak: profile.dailyStreak,
      uniqueCards,
      totalCards,
      totalCopies: totalCopies._sum.count || 0,
      wishlistCount: wishCount,
      dupeCount,
      totalSpent: spent,
      badge: currentBadge,
      nextBadge: nextBadge
        ? `${nextBadge.count - uniqueCards} → ${nextBadge.emoji} ${nextBadge.name}`
        : null,
      rarityBreakdown,
    });

    const attachment = new AttachmentBuilder(buffer, {
      name: 'economy-profile.png',
    });
    return interaction.reply({ files: [attachment] });
  }

  // ═══ /gacha gacha ═══
  @Slash({ name: 'gacha', description: `Tire une carte (${GACHA_COST} 🪙)` })
  async gacha(interaction: CommandInteraction) {
    await interaction.deferReply();
    const { userId, profile } = await this.resolve(interaction);

    // Debt block
    const debtBlock = this.debtEmbed(profile);
    if (debtBlock) return interaction.editReply({ embeds: [debtBlock] });

    if (profile.currency < GACHA_COST) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setTitle('❌ Pièces insuffisantes')
            .setDescription(
              `Il te faut **${GACHA_COST}** 🪙 · Solde : **${profile.currency}** 🪙`,
            ),
        ],
      });
    }

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: { currency: { decrement: GACHA_COST } },
    });
    await this.prisma.currencyTransaction.create({
      data: {
        userId,
        amount: -GACHA_COST,
        type: 'GACHA_PULL',
        note: 'Tirage x1',
      },
    });

    const result = await this.pullCard(userId, profile.id);
    const bal = profile.currency - GACHA_COST;

    try {
      if (result.card && result.rarity) {
        const cardBuffer = await generateGachaCard({
          name: result.card.name,
          nameJp: result.card.nameJp,
          series: result.card.series,
          rarity: result.rarity,
          beyblade: result.card.beyblade,
          description: result.card.description,
          imageUrl: result.card.imageUrl,
          isDuplicate: result.isDuplicate,
          isWished: result.isWished,
          balance: bal,
          att: result.card.att,
          def: result.card.def,
          end: result.card.end,
          equilibre: result.card.equilibre,
          element: result.card.element,
        });
        const attachment = new AttachmentBuilder(cardBuffer, {
          name: 'gacha-card.png',
        });
        const reply = await interaction.editReply({ files: [attachment] });
        const bm = await this.checkBadges(userId, profile.id);
        if (bm) await reply.reply({ content: bm });
      } else {
        const missBuffer = await generateGachaMissCard(randomMiss(), bal);
        const attachment = new AttachmentBuilder(missBuffer, {
          name: 'gacha-miss.png',
        });
        await interaction.editReply({ files: [attachment] });
      }
    } catch (canvasErr) {
      console.error('[Gacha Pull] Canvas error:', canvasErr);
      // Fallback to embed if canvas fails
      await interaction.editReply({
        embeds: [this.buildPullEmbed(result, bal)],
      });
    }
  }

  // ═══ /gacha multi ═══
  @Slash({
    name: 'multi',
    description: `Tire 10 cartes (${MULTI_PULL_COST} 🪙, -10%)`,
  })
  async multi(interaction: CommandInteraction) {
    await interaction.deferReply();
    const { userId, profile } = await this.resolve(interaction);

    const debtBlock = this.debtEmbed(profile);
    if (debtBlock) return interaction.editReply({ embeds: [debtBlock] });

    if (profile.currency < MULTI_PULL_COST) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setTitle('❌ Pièces insuffisantes')
            .setDescription(
              `Il te faut **${MULTI_PULL_COST}** 🪙 · Solde : **${profile.currency}** 🪙`,
            ),
        ],
      });
    }

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: { currency: { decrement: MULTI_PULL_COST } },
    });
    await this.prisma.currencyTransaction.create({
      data: {
        userId,
        amount: -MULTI_PULL_COST,
        type: 'MULTI_PULL',
        note: 'Tirage x10',
      },
    });

    const { generateStarFragmentGif, generateMultiPullCard } = await import(
      '../../lib/canvas-utils.js'
    );

    // Pull cards first to know rarities
    const results: PullResult[] = [];
    for (let i = 0; i < MULTI_PULL_COUNT; i++)
      results.push(await this.pullCard(userId, profile.id));

    const hits = results.filter((r) => r.card);
    const misses = results.filter((r) => !r.card);
    const bal = profile.currency - MULTI_PULL_COST;

    // Generate Star Fragment animation colored by pull rarities
    const rarities = results.map((r) => r.rarity);
    const animBuf = await generateStarFragmentGif(rarities).catch(() => null);
    if (animBuf) {
      const animAttachment = new AttachmentBuilder(animBuf, {
        name: 'invocation.gif',
      });
      await interaction.editReply({ files: [animAttachment] });
      // Wait for animation to play
      await new Promise((r) => setTimeout(r, 1800));
    }

    try {
      const cardBuffer = await generateMultiPullCard({
        slots: results.map((r) => ({
          rarity: r.rarity,
          name: r.card?.name,
          imageUrl: r.card?.imageUrl,
          isDuplicate: r.isDuplicate,
          isWished: r.isWished,
        })),
        balance: bal,
        hitsCount: hits.length,
        missCount: misses.length,
      });
      const attachment = new AttachmentBuilder(cardBuffer, {
        name: 'multi-pull.png',
      });
      // Send results as follow-up (animation stays visible above)
      const reply = await interaction.followUp({ files: [attachment] });
      if (hits.length > 0) {
        const bm = await this.checkBadges(userId, profile.id);
        if (bm) await reply.reply({ content: bm });
      }
    } catch (canvasErr) {
      console.error('[Gacha Multi] Canvas error:', canvasErr);
      // Fallback embed
      const lines = results.map((r) =>
        r.card
          ? `${RARITY_CONFIG[r.rarity!]?.emoji} **${r.card.name}** — ${RARITY_CONFIG[r.rarity!]?.label}${r.isDuplicate ? ' *(dbl)*' : ' ✨'}`
          : '💨 *Raté*',
      );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Info)
            .setTitle(`🎰 Multi x${MULTI_PULL_COUNT}`)
            .setDescription(lines.join('\n'))
            .addFields(
              {
                name: 'Résultat',
                value: `✅ **${hits.length}** cartes · 💨 **${misses.length}** ratés`,
                inline: true,
              },
              {
                name: '💰',
                value: `**${bal.toLocaleString('fr-FR')}** 🪙`,
                inline: true,
              },
            ),
        ],
      });
    }
  }

  // ═══ /gacha wish ═══
  @Slash({
    name: 'wish',
    description: 'Ajoute/retire une carte de ta wishlist',
  })
  async wish(
    @SlashOption({
      name: 'carte',
      description: 'Nom de la carte',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    cardName: string,
    interaction: CommandInteraction,
  ) {
    const { profile } = await this.resolve(interaction);
    const card = await this.prisma.gachaCard.findFirst({
      where: {
        OR: [
          { name: { contains: cardName, mode: 'insensitive' } },
          { slug: { contains: cardName.toLowerCase().replace(/\s+/g, '-') } },
        ],
        isActive: true,
      },
    });
    if (!card)
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(
              `Carte "${cardName}" introuvable. \`/gacha catalogue\``,
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });

    const existing = await this.prisma.cardWishlist.findUnique({
      where: { profileId_cardId: { profileId: profile.id, cardId: card.id } },
    });
    if (existing) {
      await this.prisma.cardWishlist.delete({ where: { id: existing.id } });
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setDescription(`❌ **${card.name}** retirée de ta wishlist.`),
        ],
      });
    }
    await this.prisma.cardWishlist.create({
      data: { profileId: profile.id, cardId: card.id },
    });
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(RARITY_CONFIG[card.rarity]?.color)
          .setTitle('⭐ Wishlist')
          .setDescription(
            `${RARITY_CONFIG[card.rarity]?.emoji} **${card.name}** ajoutée !\nEmbed doré quand tu la drop.`,
          )
          .setThumbnail(card.imageUrl || ''),
      ],
    });
  }

  // ═══ /gacha wishlist ═══
  @Slash({ name: 'wishlist', description: 'Affiche ta wishlist' })
  async wishlist(interaction: CommandInteraction) {
    const { userId, profile } = await this.resolve(interaction);
    const wishes = await this.prisma.cardWishlist.findMany({
      where: { profileId: profile.id },
      include: { card: true },
    });
    if (wishes.length === 0)
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Info)
            .setTitle('⭐ Wishlist vide')
            .setDescription(
              'Ajoute des cartes avec `/gacha wish <nom>`\nTu seras notifié par un embed doré quand tu les obtiendras !',
            ),
        ],
      });

    const owned = await this.prisma.cardInventory.findMany({
      where: { userId, cardId: { in: wishes.map((w) => w.cardId) } },
    });
    const ownedIds = new Set(owned.map((o) => o.cardId));
    const ownedCount = wishes.filter((w) => ownedIds.has(w.cardId)).length;

    const lines = wishes.map((w) => {
      const cfg = RARITY_CONFIG[w.card.rarity]!;
      const status = ownedIds.has(w.cardId) ? '✅' : '❌';
      return `${status} ${cfg.emoji} **${w.card.name}**${w.card.beyblade ? ` — *${w.card.beyblade}*` : ''}`;
    });

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(RPB.GoldColor)
          .setAuthor({
            name: interaction.user.displayName,
            iconURL: interaction.user.displayAvatarURL(),
          })
          .setTitle(`⭐ Wishlist — ${ownedCount}/${wishes.length} obtenues`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: '`/gacha wish <nom>` pour ajouter/retirer' }),
      ],
    });
  }

  // ═══ /gacha catalogue ═══
  @Slash({ name: 'catalogue', description: 'Toutes les cartes disponibles' })
  async catalogue(
    @SlashOption({
      name: 'série',
      description: 'Filtrer par série (ex: BURST, METAL_FUSION)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    series: string | undefined,
    interaction: CommandInteraction,
  ) {
    const { userId } = await this.resolve(interaction);
    const where: {
      isActive: boolean;
      series?: { contains: string; mode: 'insensitive' };
    } = { isActive: true };
    if (series) where.series = { contains: series, mode: 'insensitive' };

    const cards = await this.prisma.gachaCard.findMany({
      where,
      orderBy: [{ rarity: 'desc' }, { name: 'asc' }],
    });
    if (cards.length === 0)
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setDescription('Aucune carte trouvée.'),
        ],
        flags: MessageFlags.Ephemeral,
      });

    // Check which ones user owns
    const owned = await this.prisma.cardInventory.findMany({
      where: { userId, cardId: { in: cards.map((c) => c.id) } },
    });
    const ownedIds = new Set(owned.map((o) => o.cardId));

    // Group by series then rarity
    const bySeries: Record<string, typeof cards> = {};
    for (const c of cards) {
      const s = c.series.replace(/_/g, ' ');
      if (!bySeries[s]) bySeries[s] = [];
      bySeries[s]?.push(c);
    }

    const embeds: EmbedBuilder[] = [];
    const totalOwned = cards.filter((c) => ownedIds.has(c.id)).length;

    const mainEmbed = new EmbedBuilder()
      .setColor(RPB.Color)
      .setTitle(`📖 Catalogue — ${cards.length} cartes`)
      .setDescription(
        `Tu possèdes **${totalOwned}** / ${cards.length} (${Math.round((totalOwned / cards.length) * 100)}%)\nSéries : ${Object.keys(bySeries).join(' · ')}`,
      )
      .setFooter({ text: 'Filtre : /gacha catalogue série:BURST' });

    for (const [seriesName, seriesCards] of Object.entries(bySeries)) {
      const lines = seriesCards.map((c) => {
        const cfg = RARITY_CONFIG[c.rarity]!;
        const own = ownedIds.has(c.id) ? '✅' : '⬛';
        return `${own} ${cfg.emoji} **${c.name}**${c.beyblade ? ` — ${c.beyblade}` : ''}`;
      });
      // Split if too long for one field
      const value = lines.join('\n');
      if (value.length <= 1024) {
        mainEmbed.addFields({
          name: `📦 ${seriesName} (${seriesCards.length})`,
          value,
        });
      } else {
        mainEmbed.addFields({
          name: `📦 ${seriesName} (${seriesCards.length})`,
          value: `${lines.slice(0, 15).join('\n')}\n*... +${lines.length - 15} cartes*`,
        });
      }
    }

    embeds.push(mainEmbed);
    return interaction.reply({ embeds });
  }

  // ═══ /gacha collection ═══
  @Slash({ name: 'collection', description: 'Affiche ta collection' })
  async collection(interaction: CommandInteraction) {
    await interaction.deferReply();
    const { userId, profile } = await this.resolve(interaction);
    const inventory = await this.prisma.cardInventory.findMany({
      where: { userId },
      include: { card: true },
      orderBy: [{ card: { rarity: 'desc' } }, { card: { name: 'asc' } }],
    });
    if (inventory.length === 0)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Info)
            .setTitle('🃏 Collection vide')
            .setDescription('`/gacha gacha` pour commencer !'),
        ],
      });

    const totalCards = await this.prisma.gachaCard.count({
      where: { isActive: true },
    });
    const badgesList = BADGES.filter((b) => inventory.length >= b.count).map(
      (b) => `${b.emoji} ${b.name}`,
    );

    try {
      const cardBuffer = await generateCollectionCard({
        username: interaction.user.displayName,
        avatarUrl: interaction.user.displayAvatarURL({
          extension: 'png',
          size: 128,
        }),
        currency: profile.currency,
        streak: profile.dailyStreak,
        cards: inventory.map((inv) => ({
          name: inv.card.name,
          rarity: inv.card.rarity,
          count: inv.count,
          imageUrl: inv.card.imageUrl,
        })),
        totalCards,
        badges: badgesList,
      });
      const attachment = new AttachmentBuilder(cardBuffer, {
        name: 'collection.png',
      });
      return interaction.editReply({ files: [attachment] });
    } catch {
      // Fallback to embed
      const pct = Math.round((inventory.length / totalCards) * 100);
      const byRarity: Record<string, string[]> = {};
      for (const inv of inventory) {
        const r = inv.card.rarity;
        if (!byRarity[r]) byRarity[r] = [];
        byRarity[r]?.push(
          `${RARITY_CONFIG[r]?.emoji} ${inv.card.name}${inv.count > 1 ? ` (x${inv.count})` : ''}`,
        );
      }
      const embed = new EmbedBuilder()
        .setColor(RPB.GoldColor)
        .setTitle(`🃏 Collection de ${interaction.user.displayName}`)
        .setDescription(`**${inventory.length}** / ${totalCards} (${pct}%)`)
        .setThumbnail(interaction.user.displayAvatarURL());
      for (const r of ['SECRET', 'LEGENDARY', 'SUPER_RARE', 'RARE', 'COMMON']) {
        if (byRarity[r]?.length)
          embed.addFields({
            name: `${RARITY_CONFIG[r]?.emoji} ${RARITY_CONFIG[r]?.label} (${byRarity[r]?.length})`,
            value: byRarity[r]?.join('\n'),
          });
      }
      if (badgesList.length > 0)
        embed.addFields({ name: '🏅 Badges', value: badgesList.join(' · ') });
      return interaction.editReply({ embeds: [embed] });
    }
  }

  // ═══ /gacha vendre ═══
  @Slash({ name: 'vendre', description: 'Vends un doublon' })
  async sell(interaction: CommandInteraction) {
    await interaction.deferReply();
    const { userId } = await this.resolve(interaction);
    const dup = await this.prisma.cardInventory.findFirst({
      where: { userId, count: { gt: 1 } },
      include: { card: true },
      orderBy: { card: { rarity: 'asc' } },
    });
    if (!dup)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setDescription('Aucun doublon à vendre.'),
        ],
      });

    const cfg = RARITY_CONFIG[dup.card.rarity]!;
    await this.prisma.cardInventory.update({
      where: { id: dup.id },
      data: { count: { decrement: 1 } },
    });
    await this.prisma.profile.update({
      where: { userId },
      data: { currency: { increment: cfg.sellPrice } },
    });
    await this.prisma.currencyTransaction.create({
      data: {
        userId,
        amount: cfg.sellPrice,
        type: 'SELL_CARD',
        note: `Vente: ${dup.card.name}`,
      },
    });
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Success)
          .setDescription(
            `${cfg.emoji} **${dup.card.name}** vendue pour **${cfg.sellPrice}** 🪙 · Reste : ${dup.count - 1}`,
          ),
      ],
    });
  }

  // ═══ /gacha vendre-tout ═══
  @Slash({
    name: 'vendre-tout',
    description: "Vends TOUS tes doublons d'un coup",
  })
  async sellAll(interaction: CommandInteraction) {
    await interaction.deferReply();
    const { userId } = await this.resolve(interaction);

    const duplicates = await this.prisma.cardInventory.findMany({
      where: { userId, count: { gt: 1 } },
      include: { card: true },
    });

    if (duplicates.length === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setDescription('Aucun doublon à vendre.'),
        ],
      });
    }

    let totalCoins = 0;
    let totalSold = 0;
    const lines: string[] = [];

    for (const dup of duplicates) {
      const cfg = RARITY_CONFIG[dup.card.rarity]!;
      const extraCopies = dup.count - 1; // Keep 1, sell the rest
      const earned = cfg.sellPrice * extraCopies;

      await this.prisma.cardInventory.update({
        where: { id: dup.id },
        data: { count: 1 },
      });

      totalCoins += earned;
      totalSold += extraCopies;
      lines.push(
        `${cfg.emoji} ${dup.card.name} x${extraCopies} → **${earned}** 🪙`,
      );
    }

    await this.prisma.profile.update({
      where: { userId },
      data: { currency: { increment: totalCoins } },
    });

    await this.prisma.currencyTransaction.create({
      data: {
        userId,
        amount: totalCoins,
        type: 'SELL_CARD',
        note: `Vente en masse: ${totalSold} doublons`,
      },
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Success)
          .setTitle(`💸 ${totalSold} doublons vendus !`)
          .setDescription(
            `${lines.join('\n')}\n\n🪙 **Total : +${totalCoins.toLocaleString('fr-FR')} pièces**`,
          ),
      ],
    });
  }

  // ═══ /gacha classement ═══
  @Slash({
    name: 'classement',
    description: 'Top collectionneurs et plus riches',
  })
  async leaderboard(interaction: CommandInteraction) {
    await interaction.deferReply();
    const { userId: callerId } = await this.resolve(interaction);
    const totalCards = await this.prisma.gachaCard.count({
      where: { isActive: true },
    });

    const topCollectors = await this.prisma.cardInventory.groupBy({
      by: ['userId'],
      _count: { cardId: true },
      orderBy: { _count: { cardId: 'desc' } },
      take: 10,
    });

    const topRich = await this.prisma.profile.findMany({
      orderBy: { currency: 'desc' },
      take: 5,
      include: {
        user: {
          select: { name: true, globalName: true, id: true, image: true },
        },
      },
    });

    if (topCollectors.length === 0)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Info)
            .setDescription("Personne n'a de cartes !"),
        ],
      });

    // Build collector entries
    let callerRank = -1;
    const collectors = await Promise.all(
      topCollectors.map(async (tc, i) => {
        const u = await this.prisma.user.findUnique({
          where: { id: tc.userId },
          select: { name: true, globalName: true, image: true },
        });
        if (tc.userId === callerId) callerRank = i + 1;
        return {
          rank: i + 1,
          name: u?.globalName || u?.name || '?',
          avatarUrl: u?.image || null,
          uniqueCards: tc._count.cardId,
          totalCards: totalCards,
          percentage:
            totalCards > 0
              ? Math.round((tc._count.cardId / totalCards) * 100)
              : 0,
          isCallerRow: tc.userId === callerId,
        };
      }),
    );

    const richest = topRich.map((p, i) => ({
      rank: i + 1,
      name: p.user?.globalName || p.user?.name || '?',
      avatarUrl: p.user?.image || null,
      currency: p.currency,
      isCallerRow: p.user?.id === callerId,
    }));

    const callerUser = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { globalName: true, name: true },
    });

    const buffer = await generateGachaLeaderboardCard({
      collectors,
      richest,
      callerName: callerUser?.globalName || callerUser?.name || '?',
      callerRank,
      totalAvailableCards: totalCards,
    });

    const attachment = new AttachmentBuilder(buffer, {
      name: 'gacha-leaderboard.png',
    });
    return interaction.editReply({ files: [attachment] });
  }

  // ═══ /gacha taux ═══
  @Slash({ name: 'taux', description: 'Mécaniques et taux' })
  async rates(interaction: CommandInteraction) {
    const total = await this.prisma.gachaCard.count({
      where: { isActive: true },
    });
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(RPB.Color)
          .setTitle('🎰 Mécaniques du Gacha')
          .setDescription(
            `**${total} cartes** · x1 : **${GACHA_COST}🪙** · x10 : **${MULTI_PULL_COST}🪙**`,
          )
          .addFields(
            {
              name: '📊 Drop',
              value:
                '💨 Raté **35%** · ⚪ **30%** · 🔵 **20%** · 🟣 **10%** · 🟡 **4%** · 🔴 **1%**',
            },
            {
              name: '🪙 Daily (20h)',
              value:
                '60%: 80-120 · 25%: 150-200 · 10%: 250-350 · 4%: 500-700 · 1%: 1000-1500',
              inline: true,
            },
            {
              name: '🔥 Streak',
              value: STREAK_BONUSES.map(
                (s) => `${s.label}: +${s.bonus}🪙`,
              ).join('\n'),
              inline: true,
            },
            {
              name: '🏅 Badges',
              value: BADGES.map(
                (b) => `${b.emoji} ${b.count}: +${b.reward}🪙`,
              ).join('\n'),
            },
          ),
      ],
    });
  }

  // ═══ /gacha admin-give — Admin only ═══
  @Slash({
    name: 'admin-give',
    description: '[ADMIN] Donner des pièces à un membre',
  })
  async adminGive(
    @SlashOption({
      name: 'membre',
      description: 'Le membre',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: { id: string; displayName: string },
    @SlashOption({
      name: 'montant',
      description: 'Nombre de pièces',
      required: true,
      type: ApplicationCommandOptionType.Integer,
    })
    amount: number,
    @SlashOption({
      name: 'raison',
      description: 'Raison',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    reason: string | undefined,
    interaction: CommandInteraction,
  ) {
    // Admin check
    const caller = await this.prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });
    if (!caller || (caller.role !== 'admin' && caller.role !== 'superadmin')) {
      return interaction.reply({
        content: '❌ Réservé aux administrateurs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (amount === 0)
      return interaction.reply({
        content: '❌ Montant invalide.',
        flags: MessageFlags.Ephemeral,
      });

    // Resolve target
    let targetUser = await this.prisma.user.findUnique({
      where: { discordId: target.id },
    });
    if (!targetUser) {
      targetUser = await this.prisma.user.create({
        data: {
          discordId: target.id,
          name: target.displayName,
          email: `${target.id}@discord.rpbey.fr`,
        },
      });
    }
    let profile = await this.prisma.profile.findUnique({
      where: { userId: targetUser.id },
    });
    if (!profile) {
      profile = await this.prisma.profile.create({
        data: { userId: targetUser.id, currency: 0 },
      });
    }

    const isGive = amount > 0;
    const absAmount = Math.abs(amount);

    // No balance limit — can go negative

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: {
        currency: isGive ? { increment: absAmount } : { decrement: absAmount },
      },
    });
    await this.prisma.currencyTransaction.create({
      data: {
        userId: targetUser.id,
        amount,
        type: isGive ? 'ADMIN_GIVE' : 'ADMIN_TAKE',
        note: reason || `Par ${interaction.user.displayName}`,
      },
    });

    const newBalance = profile.currency + amount;

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(isGive ? Colors.Success : Colors.Warning)
          .setTitle(isGive ? '🪙 Pièces ajoutées' : '🪙 Pièces retirées')
          .setDescription(
            `${isGive ? '+' : ''}**${amount.toLocaleString('fr-FR')}** 🪙 ${isGive ? 'donnés à' : 'retirés de'} **${target.displayName}**` +
              (reason ? `\n📝 *${reason}*` : '') +
              `\n\n💰 Nouveau solde : **${newBalance.toLocaleString('fr-FR')}** 🪙`,
          )
          .setFooter({ text: `Par ${interaction.user.displayName}` }),
      ],
    });
  }

  // ═══ /gacha duel — Card battle ═══
  @Slash({
    name: 'duel',
    description: 'Fais combattre une carte contre un adversaire !',
  })
  async duel(
    @SlashOption({
      name: 'adversaire',
      description: 'Ton adversaire',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: { id: string; displayName: string; bot?: boolean },
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Tu ne peux pas te combattre !',
        flags: MessageFlags.Ephemeral,
      });
    if (target.bot)
      return interaction.reply({
        content: '❌ Pas de duel contre un bot !',
        flags: MessageFlags.Ephemeral,
      });

    await interaction.deferReply();
    const { userId: userIdA } = await this.resolve(interaction);

    // Get random card from each player's collection
    const invA = await this.prisma.cardInventory.findMany({
      where: { userId: userIdA },
      include: { card: true },
    });
    if (invA.length === 0)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription("Tu n'as aucune carte ! `/gacha gacha`"),
        ],
      });

    // Resolve target user
    let targetUser = await this.prisma.user.findUnique({
      where: { discordId: target.id },
    });
    if (!targetUser)
      targetUser = await this.prisma.user.create({
        data: {
          discordId: target.id,
          name: target.displayName,
          email: `${target.id}@discord.rpbey.fr`,
        },
      });

    const invB = await this.prisma.cardInventory.findMany({
      where: { userId: targetUser.id },
      include: { card: true },
    });
    if (invB.length === 0)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(`**${target.displayName}** n'a aucune carte !`),
        ],
      });

    // Pick random card from each
    const pickA = invA[Math.floor(Math.random() * invA.length)]?.card;
    const pickB = invB[Math.floor(Math.random() * invB.length)]?.card;

    // Calculate power using real card stats + element advantages
    const rarityBonus: Record<string, number> = {
      COMMON: 0,
      RARE: 10,
      SUPER_RARE: 25,
      LEGENDARY: 45,
      SECRET: 65,
    };

    const calcPower = (card: typeof pickA) => {
      const stats =
        card.att * 0.35 +
        card.def * 0.25 +
        card.end * 0.25 +
        card.equilibre * 0.015;
      const bonus = rarityBonus[card.rarity] || 0;
      const rng = Math.random() * 20; // Small random factor
      return stats + bonus + rng;
    };

    let scoreA = calcPower(pickA);
    let scoreB = calcPower(pickB);

    // Element advantage: ×1.25 damage
    const advA = ELEMENT_ADVANTAGE[pickA.element];
    const advB = ELEMENT_ADVANTAGE[pickB.element];
    if (advA?.includes(pickB.element)) scoreA *= 1.25;
    if (advB?.includes(pickA.element)) scoreB *= 1.25;

    const winner: 'A' | 'B' = scoreA >= scoreB ? 'A' : 'B';
    const finishMessages = [
      '⚡ X-TREME FINISH !',
      '💥 BURST FINISH !',
      '🔄 OVER FINISH !',
      '🌀 SPIN FINISH !',
    ];
    const finishMsg =
      finishMessages[Math.floor(Math.random() * finishMessages.length)]!;
    const coinReward =
      winner === 'A' ? Math.round(scoreA / 3) : Math.round(scoreB / 3);

    // Reward winner
    const winnerId = winner === 'A' ? userIdA : targetUser.id;
    await this.prisma.profile.update({
      where: { userId: winnerId },
      data: { currency: { increment: coinReward } },
    });
    await this.prisma.currencyTransaction.create({
      data: {
        userId: winnerId,
        amount: coinReward,
        type: 'TOURNAMENT_REWARD',
        note: `Duel gacha: ${pickA.name} vs ${pickB.name}`,
      },
    });

    try {
      const { generateGachaDuelCard } = await import(
        '../../lib/canvas-utils.js'
      );
      const buffer = await generateGachaDuelCard({
        cardA: {
          name: pickA.name,
          rarity: pickA.rarity,
          beyblade: pickA.beyblade || '???',
          imageUrl: pickA.imageUrl,
          series: pickA.series,
        },
        cardB: {
          name: pickB.name,
          rarity: pickB.rarity,
          beyblade: pickB.beyblade || '???',
          imageUrl: pickB.imageUrl,
          series: pickB.series,
        },
        playerA: interaction.user.displayName,
        playerB: target.displayName,
        winner,
        finishMessage: finishMsg,
        scoreA: Math.round(scoreA),
        scoreB: Math.round(scoreB),
        coinReward,
      });
      await interaction.editReply({
        files: [new AttachmentBuilder(buffer, { name: 'gacha-duel.png' })],
      });
    } catch {
      const winnerName =
        winner === 'A' ? interaction.user.displayName : target.displayName;
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setTitle(finishMsg)
            .setDescription(
              `**${pickA.name}** vs **${pickB.name}**\n\n🏆 **${winnerName}** gagne ! +${coinReward} 🪙`,
            ),
        ],
      });
    }
  }

  // ═══ /gacha dette ═══
  @Slash({ name: 'dette', description: 'Consulte ta dette et les intérêts' })
  async debt(interaction: CommandInteraction) {
    const { profile } = await this.resolve(interaction);

    if (profile.currency >= 0) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Success)
            .setTitle('✅ Aucune dette !')
            .setDescription(
              `Ton solde est de **${profile.currency.toLocaleString('fr-FR')}** 🪙\nTu n'as aucune dette. Continue comme ça !`,
            ),
        ],
      });
    }

    const debt = Math.abs(profile.currency);
    const dailyInterest = Math.round(debt * 0.15);
    const daysToRepay = Math.ceil(debt / 80); // Rough estimate with min daily

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x991b1b)
          .setTitle('🏦 Rapport de dette')
          .setThumbnail(interaction.user.displayAvatarURL())
          .addFields(
            {
              name: '💀 Dette totale',
              value: `**${debt.toLocaleString('fr-FR')}** 🪙`,
              inline: true,
            },
            {
              name: '📈 Intérêts / daily',
              value: `**${dailyInterest.toLocaleString('fr-FR')}** 🪙 (15%)`,
              inline: true,
            },
            {
              name: '📅 Jours estimés',
              value: `~**${daysToRepay}** jours`,
              inline: true,
            },
            {
              name: '⛔ Restrictions',
              value: [
                '> `/gacha gacha` — ❌ Bloqué',
                '> `/gacha multi` — ❌ Bloqué',
                '> `/gacha parier` — ❌ Bloqué',
                '> `/gacha daily` — ✅ Autorisé (intérêts prélevés)',
                '> `/gacha duel` — ✅ Autorisé',
                '> `/gacha vendre` — ✅ Autorisé',
                '> `/jeu combat` — ✅ Autorisé',
              ].join('\n'),
            },
            {
              name: '💡 Comment rembourser',
              value:
                '• **Daily** chaque jour (récompense - 5% intérêts)\n• **Vendre** tes doublons de cartes\n• **Combats** et **duels** pour gagner des pièces\n• Demander un **admin-give** (si gentil admin)',
            },
          )
          .setFooter({
            text: 'Les intérêts sont prélevés sur chaque /gacha daily',
          }),
      ],
    });
  }

  // ═══ /gacha parier ═══
  @Slash({
    name: 'parier',
    description: 'Parie des pièces — quitte ou double !',
  })
  async bet(
    @SlashOption({
      name: 'mise',
      description: 'Montant à parier',
      required: true,
      type: ApplicationCommandOptionType.Integer,
    })
    mise: number,
    interaction: CommandInteraction,
  ) {
    if (mise <= 0)
      return interaction.reply({
        content: '❌ Mise invalide.',
        flags: MessageFlags.Ephemeral,
      });

    await interaction.deferReply();
    const { userId, profile } = await this.resolve(interaction);

    // Debt block
    const debtBlock = this.debtEmbed(profile);
    if (debtBlock) return interaction.editReply({ embeds: [debtBlock] });

    if (mise > profile.currency) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setTitle('❌ Fonds insuffisants')
            .setDescription(
              `Tu n'as que **${profile.currency.toLocaleString('fr-FR')}** 🪙\nMise demandée : **${mise.toLocaleString('fr-FR')}** 🪙`,
            ),
        ],
      });
    }

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: { currency: { decrement: mise } },
    });

    // 45% win (×2), 35% lose, 15% jackpot (×3), 5% super jackpot (×5)
    const roll = Math.random();
    let multiplier: number;
    let result: string;
    let color: number;
    let emoji: string;

    if (roll < 0.05) {
      // 5% — SUPER JACKPOT ×5
      multiplier = 5;
      result = '💎 SUPER JACKPOT !!!';
      color = 0xef4444;
      emoji = '💎';
    } else if (roll < 0.2) {
      // 15% — JACKPOT ×3
      multiplier = 3;
      result = '🎰 JACKPOT !';
      color = 0xfbbf24;
      emoji = '🎰';
    } else if (roll < 0.55) {
      // 35% — WIN ×2
      multiplier = 2;
      result = '✅ Gagné !';
      color = Colors.Success;
      emoji = '✅';
    } else {
      // 45% — LOSE ×0
      multiplier = 0;
      result = '💀 Perdu...';
      color = 0x4b5563;
      emoji = '💀';
    }

    const gain = mise * multiplier;
    const net = gain - mise; // Already deducted mise, so add back gain

    if (gain > 0) {
      await this.prisma.profile.update({
        where: { id: profile.id },
        data: { currency: { increment: gain } },
      });
    }

    const newBalance = profile.currency - mise + gain;

    await this.prisma.currencyTransaction.create({
      data: {
        userId,
        amount: net,
        type: 'GACHA_PULL',
        note: `Pari: mise ${mise} → x${multiplier} (${net >= 0 ? '+' : ''}${net})`,
      },
    });

    const beyMessages: Record<number, string[]> = {
      0: [
        'Ta toupie a été éjectée du stadium... tout est perdu !',
        'Burst ! Ta mise est partie en fumée !',
        'Ring Out ! Les pièces tombent dans le vide...',
        'L-Drago a absorbé toute ta mise !',
      ],
      2: [
        'Ta toupie tient bon ! Tu doubles la mise !',
        'Spin Finish en ta faveur !',
        'Over Finish ! Tu remportes le pot !',
      ],
      3: [
        'Burst Finish critique ! Triple mise !',
        'Combo dévastateur ! Le jackpot est à toi !',
        'X-treme Finish ! Triple récompense !',
      ],
      5: [
        'XTREME FINISH LÉGENDAIRE !!! ×5 !!!',
        'TON BEY SPIRIT EXPLOSE ! QUINTUPLE MISE !!!',
        'PEGASUS COSMIQUE ! GAIN ASTRONOMIQUE !!!',
      ],
    };

    const messages = beyMessages[multiplier] || beyMessages[0]!;
    const flavorText = messages[Math.floor(Math.random() * messages.length)]!;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${emoji} ${result}`)
      .setDescription(flavorText)
      .addFields(
        {
          name: '🎲 Mise',
          value: `**${mise.toLocaleString('fr-FR')}** 🪙`,
          inline: true,
        },
        {
          name: `${multiplier > 0 ? '💰' : '💀'} Résultat`,
          value:
            multiplier > 0
              ? `**×${multiplier}** → **+${(gain - mise).toLocaleString('fr-FR')}** 🪙`
              : `**-${mise.toLocaleString('fr-FR')}** 🪙`,
          inline: true,
        },
        {
          name: '🏦 Solde',
          value: `**${newBalance.toLocaleString('fr-FR')}** 🪙`,
          inline: true,
        },
      )
      .setFooter({
        text: `Probabilités : 45% ×2 · 15% ×3 · 5% ×5 · 35% perdu`,
      });

    if (multiplier >= 3) {
      embed.setThumbnail(interaction.user.displayAvatarURL());
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // ═══ /gacha voir — View a specific card ═══
  @Slash({ name: 'voir', description: 'Affiche une carte en détail' })
  async viewCard(
    @SlashOption({
      name: 'carte',
      description: 'Nom de la carte à afficher',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    cardName: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const { userId } = await this.resolve(interaction);

    const card = await this.prisma.gachaCard.findFirst({
      where: {
        OR: [
          { name: { contains: cardName, mode: 'insensitive' } },
          { slug: { contains: cardName.toLowerCase().replace(/\s+/g, '-') } },
        ],
        isActive: true,
      },
      include: { drop: true },
    });

    if (!card) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(
              `Carte "${cardName}" introuvable. \`/gacha catalogue\``,
            ),
        ],
      });
    }

    // Check ownership
    const inv = await this.prisma.cardInventory.findUnique({
      where: { userId_cardId: { userId, cardId: card.id } },
    });
    const owned = !!inv;
    const count = inv?.count ?? 0;

    // Check wishlist
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
    });
    const isWished = profile
      ? !!(await this.prisma.cardWishlist.findUnique({
          where: {
            profileId_cardId: { profileId: profile.id, cardId: card.id },
          },
        }))
      : false;

    try {
      const cardBuffer = await generateGachaCard({
        name: card.name,
        nameJp: card.nameJp,
        series: card.series,
        rarity: card.rarity as CardRarityType,
        beyblade: card.beyblade,
        description: card.description,
        imageUrl: card.imageUrl,
        isDuplicate: count > 1,
        isWished,
        balance: profile?.currency ?? 0,
        att: card.att,
        def: card.def,
        end: card.end,
        equilibre: card.equilibre,
        element: card.element,
      });
      const attachment = new AttachmentBuilder(cardBuffer, {
        name: 'gacha-card.png',
      });

      const cfg = RARITY_CONFIG[card.rarity]!;
      const ELEMENT_LABELS: Record<string, string> = {
        FEU: '🔥 Feu',
        EAU: '💧 Eau',
        TERRE: '🌍 Terre',
        VENT: '🌪️ Vent',
        OMBRE: '🌑 Ombre',
        LUMIERE: '✨ Lumière',
        NEUTRAL: '⚪ Neutre',
      };

      const embed = new EmbedBuilder()
        .setColor(cfg.color)
        .setTitle(
          `${cfg.emoji} ${card.name}${card.nameJp ? ` (${card.nameJp})` : ''}`,
        )
        .setDescription(
          [
            card.description || '',
            '',
            `**Rareté :** ${cfg.label}`,
            card.beyblade ? `**Toupie :** 🌀 ${card.beyblade}` : null,
            `**Élément :** ${ELEMENT_LABELS[card.element] || card.element}`,
            card.specialMove ? `**Coup spécial :** ${card.specialMove}` : null,
            '',
            `**Stats :** ATT ${card.att} · DEF ${card.def} · END ${card.end} · ÉQU ${card.equilibre}`,
            '',
            owned ? `✅ Possédée (×${count})` : '❌ Non possédée',
            isWished ? '⭐ Dans ta wishlist' : null,
            card.drop ? `📦 Drop : ${card.drop.name}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .setFooter({ text: `Valeur de vente : ${cfg.sellPrice} 🪙` });

      return interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch {
      // Fallback embed without canvas
      const cfg = RARITY_CONFIG[card.rarity]!;
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(cfg.color)
            .setTitle(`${cfg.emoji} ${card.name}`)
            .setDescription(card.description || '')
            .setThumbnail(card.imageUrl || '')
            .addFields(
              { name: 'Rareté', value: cfg.label, inline: true },
              { name: 'Élément', value: card.element, inline: true },
              {
                name: 'Stats',
                value: `ATT ${card.att} · DEF ${card.def} · END ${card.end} · ÉQU ${card.equilibre}`,
              },
            ),
        ],
      });
    }
  }

  // ═══ /gacha donner — Give currency to another player ═══
  @Slash({
    name: 'donner',
    description: 'Donne des pièces à un autre joueur',
  })
  async giveCurrency(
    @SlashOption({
      name: 'membre',
      description: 'Le membre à qui donner',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: { id: string; displayName: string; bot?: boolean },
    @SlashOption({
      name: 'montant',
      description: 'Nombre de pièces à donner',
      required: true,
      type: ApplicationCommandOptionType.Integer,
    })
    amount: number,
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Tu ne peux pas te donner des pièces !',
        flags: MessageFlags.Ephemeral,
      });
    if (target.bot)
      return interaction.reply({
        content: '❌ Tu ne peux pas donner à un bot !',
        flags: MessageFlags.Ephemeral,
      });
    if (amount <= 0)
      return interaction.reply({
        content: '❌ Montant invalide.',
        flags: MessageFlags.Ephemeral,
      });

    await interaction.deferReply();
    const { userId, profile } = await this.resolve(interaction);

    if (profile.currency < amount) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setTitle('❌ Fonds insuffisants')
            .setDescription(
              `Tu n'as que **${profile.currency.toLocaleString('fr-FR')}** 🪙`,
            ),
        ],
      });
    }

    // Cooldown check
    if (
      profile.lastGiftSent &&
      Date.now() - profile.lastGiftSent.getTime() < GIFT_COOLDOWN_MS
    ) {
      const nextGift = Math.floor(
        (profile.lastGiftSent.getTime() + GIFT_COOLDOWN_MS) / 1000,
      );
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setTitle('⏳ Cooldown')
            .setDescription(`Tu pourras donner à nouveau <t:${nextGift}:R>`),
        ],
      });
    }

    // Resolve target
    let targetUser = await this.prisma.user.findUnique({
      where: { discordId: target.id },
    });
    if (!targetUser) {
      targetUser = await this.prisma.user.create({
        data: {
          discordId: target.id,
          name: target.displayName,
          email: `${target.id}@discord.rpbey.fr`,
        },
      });
    }
    let targetProfile = await this.prisma.profile.findUnique({
      where: { userId: targetUser.id },
    });
    if (!targetProfile) {
      targetProfile = await this.prisma.profile.create({
        data: { userId: targetUser.id, currency: 0 },
      });
    }

    // Transfer
    await this.prisma.profile.update({
      where: { id: profile.id },
      data: { currency: { decrement: amount }, lastGiftSent: new Date() },
    });
    await this.prisma.profile.update({
      where: { id: targetProfile.id },
      data: { currency: { increment: amount } },
    });

    // Log transactions
    await this.prisma.currencyTransaction.createMany({
      data: [
        {
          userId,
          amount: -amount,
          type: 'ADMIN_GIVE',
          note: `Don à ${target.displayName}`,
        },
        {
          userId: targetUser.id,
          amount,
          type: 'ADMIN_GIVE',
          note: `Don de ${interaction.user.displayName}`,
        },
      ],
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Success)
          .setTitle('🎁 Don effectué !')
          .setDescription(
            `**${amount.toLocaleString('fr-FR')}** 🪙 envoyés à **${target.displayName}** !`,
          )
          .addFields(
            {
              name: '💰 Ton solde',
              value: `**${(profile.currency - amount).toLocaleString('fr-FR')}** 🪙`,
              inline: true,
            },
            {
              name: `💰 Solde de ${target.displayName}`,
              value: `**${(targetProfile.currency + amount).toLocaleString('fr-FR')}** 🪙`,
              inline: true,
            },
          )
          .setFooter({ text: 'Prochain don possible dans 12h' }),
      ],
    });
  }

  // ═══ /gacha échange — Trade a card with another player ═══
  @Slash({
    name: 'echange',
    description: 'Échange une carte avec un autre joueur',
  })
  async tradeCard(
    @SlashOption({
      name: 'adversaire',
      description: 'Le joueur avec qui échanger',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: { id: string; displayName: string; bot?: boolean },
    @SlashOption({
      name: 'ta-carte',
      description: 'Nom de la carte que tu donnes',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    myCardName: string,
    @SlashOption({
      name: 'sa-carte',
      description: 'Nom de la carte que tu veux',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    theirCardName: string,
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Tu ne peux pas échanger avec toi-même !',
        flags: MessageFlags.Ephemeral,
      });
    if (target.bot)
      return interaction.reply({
        content: "❌ Pas d'échange avec un bot !",
        flags: MessageFlags.Ephemeral,
      });

    await interaction.deferReply();
    const { userId: myUserId } = await this.resolve(interaction);

    // Find cards
    const myCard = await this.prisma.gachaCard.findFirst({
      where: {
        OR: [
          { name: { contains: myCardName, mode: 'insensitive' } },
          { slug: { contains: myCardName.toLowerCase().replace(/\s+/g, '-') } },
        ],
        isActive: true,
      },
    });
    const theirCard = await this.prisma.gachaCard.findFirst({
      where: {
        OR: [
          { name: { contains: theirCardName, mode: 'insensitive' } },
          {
            slug: {
              contains: theirCardName.toLowerCase().replace(/\s+/g, '-'),
            },
          },
        ],
        isActive: true,
      },
    });

    if (!myCard)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(`Carte "${myCardName}" introuvable.`),
        ],
      });
    if (!theirCard)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(`Carte "${theirCardName}" introuvable.`),
        ],
      });

    // Check I own my card
    const myInv = await this.prisma.cardInventory.findUnique({
      where: { userId_cardId: { userId: myUserId, cardId: myCard.id } },
    });
    if (!myInv || myInv.count < 1)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(`Tu ne possèdes pas **${myCard.name}** !`),
        ],
      });

    // Resolve target user
    const targetUser = await this.prisma.user.findUnique({
      where: { discordId: target.id },
    });
    if (!targetUser)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(
              `**${target.displayName}** n'a pas de compte gacha.`,
            ),
        ],
      });

    // Check they own their card
    const theirInv = await this.prisma.cardInventory.findUnique({
      where: {
        userId_cardId: { userId: targetUser.id, cardId: theirCard.id },
      },
    });
    if (!theirInv || theirInv.count < 1)
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setDescription(
              `**${target.displayName}** ne possède pas **${theirCard.name}** !`,
            ),
        ],
      });

    // Execute trade atomically
    // Remove from both, add to both
    await this.prisma.cardInventory.update({
      where: { id: myInv.id },
      data: { count: { decrement: 1 } },
    });
    await this.prisma.cardInventory.update({
      where: { id: theirInv.id },
      data: { count: { decrement: 1 } },
    });

    // Give my card to them
    await this.prisma.cardInventory.upsert({
      where: {
        userId_cardId: { userId: targetUser.id, cardId: myCard.id },
      },
      create: { userId: targetUser.id, cardId: myCard.id, count: 1 },
      update: { count: { increment: 1 } },
    });

    // Give their card to me
    await this.prisma.cardInventory.upsert({
      where: {
        userId_cardId: { userId: myUserId, cardId: theirCard.id },
      },
      create: { userId: myUserId, cardId: theirCard.id, count: 1 },
      update: { count: { increment: 1 } },
    });

    // Clean up zero-count entries
    await this.prisma.cardInventory.deleteMany({
      where: { count: { lte: 0 } },
    });

    const myCfg = RARITY_CONFIG[myCard.rarity]!;
    const theirCfg = RARITY_CONFIG[theirCard.rarity]!;

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Success)
          .setTitle('🔄 Échange réussi !')
          .setDescription(
            `**${interaction.user.displayName}** a donné ${myCfg.emoji} **${myCard.name}**\n` +
              `**${target.displayName}** a donné ${theirCfg.emoji} **${theirCard.name}**`,
          )
          .setFooter({
            text: 'Les deux joueurs ont reçu leur nouvelle carte !',
          }),
      ],
    });
  }

  // ═══ /gacha drop — Show active drop info ═══
  @Slash({ name: 'drop', description: 'Info sur le drop actif' })
  async dropInfo(interaction: CommandInteraction) {
    const { userId } = await this.resolve(interaction);

    const drop = await this.prisma.gachaDrop.findFirst({
      where: { isActive: true },
      include: { cards: { orderBy: [{ rarity: 'desc' }, { name: 'asc' }] } },
    });

    if (!drop) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setTitle('📦 Aucun drop actif')
            .setDescription(
              "Aucun drop de cartes n'est actif actuellement. Reviens plus tard !",
            ),
        ],
      });
    }

    // Count owned cards from this drop
    const ownedCards = await this.prisma.cardInventory.findMany({
      where: { userId, cardId: { in: drop.cards.map((c) => c.id) } },
    });
    const ownedIds = new Set(ownedCards.map((o) => o.cardId));

    // Rarity breakdown
    const rarityCounts: Record<string, { total: number; owned: number }> = {};
    for (const card of drop.cards) {
      if (!rarityCounts[card.rarity])
        rarityCounts[card.rarity] = { total: 0, owned: 0 };
      rarityCounts[card.rarity]!.total++;
      if (ownedIds.has(card.id)) rarityCounts[card.rarity]!.owned++;
    }

    const endTimestamp = Math.floor(drop.endDate.getTime() / 1000);
    const pct =
      drop.cards.length > 0
        ? Math.round((ownedIds.size / drop.cards.length) * 100)
        : 0;
    const progressBar =
      '▓'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));

    const rarityLines = ['LEGENDARY', 'SUPER_RARE', 'RARE', 'COMMON']
      .filter((r) => rarityCounts[r])
      .map((r) => {
        const cfg = RARITY_CONFIG[r]!;
        const rc = rarityCounts[r]!;
        return `${cfg.emoji} ${cfg.label} : **${rc.owned}/${rc.total}**`;
      });

    const embed = new EmbedBuilder()
      .setColor(RPB.GoldColor)
      .setTitle(`📦 Drop ${drop.season} — ${drop.name}`)
      .setDescription(
        [
          `*${drop.theme}*`,
          '',
          `**Cartes :** ${drop.cards.length} / ${drop.maxCards}`,
          `**Fin :** <t:${endTimestamp}:R> (<t:${endTimestamp}:D>)`,
          '',
          `**Ta progression :** ${ownedIds.size}/${drop.cards.length} (${pct}%)`,
          `\`${progressBar}\``,
          '',
          ...rarityLines,
        ].join('\n'),
      )
      .setFooter({
        text: 'Les cartes de ce drop apparaissent en priorité dans les tirages !',
      });

    if (drop.imageUrl) embed.setThumbnail(drop.imageUrl);

    return interaction.reply({ embeds: [embed] });
  }
}
