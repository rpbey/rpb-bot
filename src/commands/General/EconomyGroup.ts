import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  type CommandInteraction,
} from 'discord.js';
import { Discord, Guard, Slash, SlashGroup, SlashOption } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { StaffOnly } from '../../guards/StaffOnly.js';
import { Colors, RPB } from '../../lib/constants.js';
import {
  GachaApiError,
  createGachaClient,
  type GachaApiClient,
} from '../../lib/gacha-api.js';
import { fetchCardPng, fetchInventoryMosaicPng, fetchLeaderboardPng, fetchProfileCardPng } from '../../lib/gacha-images.js';
import { PrismaService } from '../../lib/prisma.js';

// ─── Config ─────────────────────────────────────────────────────────────────
// These constants are bot-side only (used for bot-only commands: parier, dette)
// and for the help/taux embed text. They should match the gacha server values.

const GACHA_COST = 50;
const MULTI_PULL_COST = 450;

const DAILY_TIERS = [
  { weight: 60, min: 80, max: 120, msg: '+**{n}** pièces ajoutées à ta collection !' },
  { weight: 25, min: 150, max: 200, msg: 'Beau tirage ! +**{n}** pièces !' },
  { weight: 10, min: 250, max: 350, msg: 'Excellent ! Une vraie pépite ! +**{n}** pièces !' },
  { weight: 4, min: 500, max: 700, msg: '🌟 Incroyable ! Un trésor ultra-rare ! +**{n}** pièces !' },
  { weight: 1, min: 1000, max: 1500, msg: '💎✨ JACKPOT LÉGENDAIRE !!! +**{n}** pièces !!!' },
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

const RARITY_CONFIG: Record<string, { emoji: string; color: number; label: string; sellPrice: number }> = {
  COMMON: { emoji: '⚪', color: 0x9ca3af, label: 'Commune', sellPrice: 5 },
  RARE: { emoji: '🔵', color: 0x3b82f6, label: 'Rare', sellPrice: 15 },
  SUPER_RARE: { emoji: '🟣', color: 0x8b5cf6, label: 'Super Rare', sellPrice: 50 },
  LEGENDARY: { emoji: '🟡', color: 0xfbbf24, label: 'Légendaire', sellPrice: 150 },
  SECRET: { emoji: '🔴', color: 0xef4444, label: 'Secrète', sellPrice: 500 },
};

// Gift cooldown (bot-side guard for the currency-give command)
const GIFT_COOLDOWN_MS = 12 * 3_600_000;

// ─── Gacha-unavailable helper ────────────────────────────────────────────────

function serviceDownEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Error)
    .setTitle('⚠️ Service indisponible')
    .setDescription(
      'Le service gacha est temporairement indisponible.\nRéessaie dans quelques instants.',
    );
}

function gachaErrorEmbed(err: GachaApiError): EmbedBuilder {
  const knownMessages: Record<string, string> = {
    INSUFFICIENT_FUNDS: 'Solde insuffisant pour effectuer cette action.',
    NOT_FOUND: 'Élément introuvable.',
    ALREADY_CLAIMED: 'Déjà réclamé.',
    RATE_LIMIT: err.retryInMs
      ? `Trop de tentatives. Réessaie dans **${Math.ceil(err.retryInMs / 1000)}s**.`
      : 'Trop de tentatives. Réessaie dans un moment.',
    NOT_OWNER: "Tu ne possèdes pas cet élément.",
    NO_ELIGIBLE_CARDS: "Aucune carte éligible.",
    COOLDOWN: err.retryInMs
      ? `Cooldown actif. Disponible dans **${Math.ceil(err.retryInMs / 1000)}s**.`
      : "Cooldown actif. Réessaie plus tard.",
    IN_DEBT:
      '🏦 **Dette active !** Commandes de tirage bloquées.\nRembourse avec `/gacha daily`, `/gacha vendre-tout`, ou `/jeu combat`.',
    UNAUTHORIZED: 'Non autorisé.',
  };
  const msg = knownMessages[err.code] ?? err.message;
  return new EmbedBuilder().setColor(Colors.Error).setTitle('❌ Erreur').setDescription(msg);
}

// ─── Helper: debtEmbed (Prisma direct — bot-only feature) ────────────────────
// Used in /gacha parier and /gacha gacha local fallback.

function debtEmbedLocal(currency: number): EmbedBuilder | null {
  if (currency >= 0) return null;
  const debt = Math.abs(currency);
  const interest = Math.round(debt * 0.15);
  return new EmbedBuilder()
    .setColor(0x991b1b)
    .setTitle('🏦 Recouvrement de dette')
    .setDescription(
      `Tu as une dette de **${debt.toLocaleString('fr-FR')}** 🪙 !\nIntérêts quotidiens : **${interest.toLocaleString('fr-FR')}** 🪙 (15%)\n\n` +
        '**Commandes bloquées** : gacha, multi, parier\n\n' +
        '💡 Pour rembourser :\n> `/gacha daily` · `/gacha vendre-tout` · `/jeu combat` · `/gacha duel`',
    )
    .setFooter({ text: "Rembourse pour débloquer les tirages ! · /gacha dette pour plus d'infos" });
}

// ─── Command Group ──────────────────────────────────────────────────────────

@Discord()
@SlashGroup({ name: 'gacha', description: 'Système de cartes à collectionner RPB' })
@SlashGroup('gacha')
@Guard(StaffOnly)
@injectable()
export class EconomyGroup {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  /** Get a gacha API client for the calling user. */
  private async api(interaction: CommandInteraction): Promise<GachaApiClient> {
    return createGachaClient(interaction.user.id, interaction.user.displayName);
  }

  // ═══ /gacha aide ═══
  @Slash({ name: 'aide', description: 'Guide complet du système gacha TCG' })
  async help(interaction: CommandInteraction) {
    // Fetch live card count from gacha API (graceful fallback)
    let totalCards = 82; // fallback count
    try {
      const api = await this.api(interaction);
      const rates = await api.rates();
      // rates doesn't include total cards; use search to count active cards
      const items = await api.searchCards('', 1);
      void items; // just checking connectivity
    } catch {
      // ignore — help embed works without it
    }

    try {
      // Try to get actual count via a Prisma call (still works for help embed)
      totalCards = await this.prisma.gachaCard.count({ where: { isActive: true } });
    } catch {
      // ignore
    }

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
          `\`/gacha gacha\` — Tirage unique (**${GACHA_COST}🪙**)`,
          `\`/gacha multi\` — Tirage x10 (**${MULTI_PULL_COST}🪙**, économie 10%)`,
          '',
          '**Taux :**  💨 Raté **30%** · ⚪ **35%** · 🔵 **22%** · 🟣 **10%** · 🟡 **3%**',
          '**Pity :** Carte garantie après **3 ratés** consécutifs',
        ].join('\n'),
      },
      {
        name: '⚔️ Combat de cartes',
        value: [
          '`/gacha duel @user` — Tes cartes s\'affrontent !',
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
      .setFooter({ text: 'RPB Gacha TCG — Collectionne, combats, domine ! 🌀' });

    return interaction.reply({ embeds: [embed1, embed2, embed3, embed4] });
  }

  // ═══ /gacha daily ═══
  @Slash({ name: 'daily', description: 'Réclame tes pièces quotidiennes' })
  async daily(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const result = await api.daily();

      const tierEmojis = ['🪙', '✨', '💫', '🌟', '💎'];
      const tierColors = [Colors.Info, Colors.Success, Colors.Warning, 0xfbbf24, 0xef4444];
      const tierLabels = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4 ⭐', 'Tier 5 💎'];
      const newStreak = result.streakAfter;
      const streakBar =
        '🔥'.repeat(Math.min(newStreak, 10)) + (newStreak > 10 ? ` ×${newStreak}` : '');
      const nextStreakBonus = STREAK_BONUSES.find((s) => s.days > newStreak);

      const embed = new EmbedBuilder()
        .setColor(tierColors[result.tier] ?? Colors.Info)
        .setTitle(
          `${tierEmojis[result.tier]} ${result.tier >= 3 ? 'DAILY EXCEPTIONNEL !' : 'Récompense quotidienne'}`,
        )
        .setDescription(result.message)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          {
            name: '💰 Solde',
            value: `**${result.newBalance.toLocaleString('fr-FR')}** 🪙`,
            inline: true,
          },
          { name: '🎲 Tier', value: tierLabels[result.tier] || 'Tier 1', inline: true },
          {
            name: '🔥 Streak',
            value: `${streakBar}\n**${newStreak}** jour${newStreak > 1 ? 's' : ''}`,
            inline: false,
          },
        );

      if ((result.streakBonus ?? 0) > 0 && result.streakBonusLabel) {
        embed.addFields({
          name: `🎁 Bonus streak ${result.streakBonusLabel} !`,
          value: `+**${result.streakBonus}** 🪙 bonus`,
          inline: true,
        });
      }
      if ((result.interestPaid ?? 0) > 0) {
        embed.addFields({
          name: '🏦 Intérêts dette (15%)',
          value: `**-${result.interestPaid}** 🪙 prélevés sur ta récompense`,
          inline: true,
        });
      }
      if (result.streakBroken) {
        embed.addFields({
          name: '💔 Streak perdu',
          value: `Ton streak a été réinitialisé.`,
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
    } catch (err) {
      if (err instanceof GachaApiError && err.code === 'COOLDOWN') {
        const retryMs = err.retryInMs ?? 0;
        const nextTimestamp = Math.floor((Date.now() + retryMs) / 1000);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Warning)
              .setTitle('⏳ Trop tôt !')
              .setDescription(`Reviens <t:${nextTimestamp}:R> (<t:${nextTimestamp}:T>)`)
              .setFooter({ text: 'Ne casse pas ton streak !' }),
          ],
        });
      }
      if (err instanceof GachaApiError) {
        return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      }
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha solde ═══
  @Slash({ name: 'solde', description: 'Affiche ton profil économie' })
  async balance(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const [bal, inv, badges] = await Promise.all([
        api.balance(),
        api.inventory({ limit: 200 }),
        api.badges().catch(() => null),
      ]);

      const uniqueCards = inv.total;
      const totalCards = await this.prisma.gachaCard.count({ where: { isActive: true } }).catch(() => 82);
      const pct = totalCards > 0 ? Math.round((uniqueCards / totalCards) * 100) : 0;

      let currentBadge = '';
      for (const b of [...BADGES].reverse()) {
        if (uniqueCards >= b.count) {
          currentBadge = `${b.emoji} ${b.name}`;
          break;
        }
      }
      const nextBadge = BADGES.find((b) => b.count > uniqueCards);

      // Rarity breakdown from inventory
      const rarityCount: Record<string, number> = {};
      for (const item of inv.items) {
        rarityCount[item.card.rarity] = (rarityCount[item.card.rarity] || 0) + 1;
      }
      const rarityBreakdown = ['SECRET', 'LEGENDARY', 'SUPER_RARE', 'RARE', 'COMMON']
        .filter((r) => rarityCount[r])
        .map((r) => ({ rarity: r, count: rarityCount[r] || 0, emoji: RARITY_CONFIG[r]?.emoji || '⚪' }));

      // Try to get profile card image from gacha server
      // We need the internal userId from the session cache — get it from balance endpoint
      const profileAttachment = await fetchProfileCardPng(
        interaction.user.id,
        // We pass discordId here; the gacha server uses userId internally.
        // The profile card endpoint uses internal userId. We can get it via
        // the session cache by calling createGachaClient again but that's
        // wasteful — instead we map via the users table (already done by balance).
        // For now we pass undefined and fall through to embed.
        undefined,
      ).catch(() => null);

      if (profileAttachment) {
        return interaction.editReply({ files: [profileAttachment] });
      }

      // Fallback embed
      const bar = '▓'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));

      const embed = new EmbedBuilder()
        .setColor(RPB.Color)
        .setTitle(`💰 Profil de ${interaction.user.displayName}`)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: '🪙 Pièces', value: `**${bal.currency.toLocaleString('fr-FR')}** 🪙`, inline: true },
          { name: '🔥 Streak', value: `**${bal.dailyStreak}** jour${bal.dailyStreak > 1 ? 's' : ''}`, inline: true },
          {
            name: `🃏 Collection — ${uniqueCards}/${totalCards} (${pct}%)`,
            value: `\`${bar}\``,
          },
        );

      if (rarityBreakdown.length > 0) {
        embed.addFields({
          name: '📊 Par rareté',
          value: rarityBreakdown.map((r) => `${r.emoji} ${r.count}`).join(' · '),
          inline: true,
        });
      }
      if (currentBadge) {
        embed.addFields({ name: '🏅 Badge', value: currentBadge, inline: true });
      }
      if (nextBadge && badges) {
        embed.addFields({
          name: '🎯 Prochain badge',
          value: `${nextBadge.emoji} ${nextBadge.name} (encore ${nextBadge.count - uniqueCards} cartes)`,
          inline: true,
        });
      }

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha gacha ═══
  @Slash({ name: 'gacha', description: `Tire une carte (${GACHA_COST} 🪙)` })
  async gacha(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const result = await api.pull();
      const bal = result.newBalance;

      if (!result.card || !result.rarity) {
        // Miss
        const missEmbed = new EmbedBuilder()
          .setColor(0x4b5563)
          .setTitle('💨 Raté !')
          .setDescription(`La toupie s'est éjectée du stadium...\n\n💰 Solde : **${bal.toLocaleString('fr-FR')}** 🪙`)
          .setFooter({ text: 'Retente ta chance !' });

        return interaction.editReply({ embeds: [missEmbed] });
      }

      // Try to fetch card image from gacha server
      const cardAttachment = await fetchCardPng(result.card.id).catch(() => null);

      const cfg = RARITY_CONFIG[result.rarity]!;
      let title = `${cfg.emoji} Carte ${cfg.label} obtenue !`;
      if (result.rarity === 'SECRET') title = '✨🔴 CARTE SECRÈTE !!! 🔴✨';
      else if (result.rarity === 'LEGENDARY') title = '⭐🟡 Carte LÉGENDAIRE ! 🟡⭐';

      const embed = new EmbedBuilder()
        .setColor(result.isWished ? 0xfbbf24 : cfg.color)
        .setTitle(result.isWished ? `⭐ ${title}` : title)
        .setDescription(
          `**${result.card.name}**${result.card.nameJp ? ` (${result.card.nameJp})` : ''}\n${result.card.series.replace(/_/g, ' ')}\n\n${result.card.description || ''}` +
            (result.card.beyblade ? `\n\n🌀 **Toupie :** ${result.card.beyblade}` : '') +
            (result.isWished ? '\n\n⭐ **CARTE SOUHAITÉE !**' : '') +
            (result.isDuplicate ? '\n📋 *Doublon — `/gacha vendre`*' : ''),
        )
        .setFooter({ text: `💰 Solde : ${bal.toLocaleString('fr-FR')} 🪙` });

      if (result.card.imageUrl && !cardAttachment) embed.setThumbnail(result.card.imageUrl);

      const replyOpts = cardAttachment
        ? { embeds: [embed], files: [cardAttachment] }
        : { embeds: [embed] };

      const reply = await interaction.editReply(replyOpts);

      // Badge notification
      if (result.badgeUnlocked) {
        const b = result.badgeUnlocked;
        await reply.reply({ content: `${b.emoji} **Badge "${b.name}" débloqué !** +${b.reward} 🪙` }).catch(() => null);
      }

      return reply;
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha multi ═══
  @Slash({ name: 'multi', description: `Tire 10 cartes (${MULTI_PULL_COST} 🪙, -10%)` })
  async multi(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const result = await api.pullMulti();
      const bal = result.newBalance;
      const results = result.results;

      const lines = results.map((r) =>
        r.card
          ? `${RARITY_CONFIG[r.rarity!]?.emoji} **${r.card.name}** — ${RARITY_CONFIG[r.rarity!]?.label}${r.isDuplicate ? ' *(dbl)*' : ' ✨'}${r.isWished ? ' ⭐' : ''}`
          : '💨 *Raté*',
      );

      const hits = results.filter((r) => r.card);
      const misses = results.filter((r) => !r.card);

      const embed = new EmbedBuilder()
        .setColor(Colors.Info)
        .setTitle(`🎰 Multi x10`)
        .setDescription(lines.join('\n'))
        .addFields(
          { name: 'Résultat', value: `✅ **${hits.length}** cartes · 💨 **${misses.length}** ratés`, inline: true },
          { name: '💰 Solde', value: `**${bal.toLocaleString('fr-FR')}** 🪙`, inline: true },
        );

      const reply = await interaction.editReply({ embeds: [embed] });

      // Badge notification for any badge unlocked in results
      const badgeResult = results.find((r) => r.badgeUnlocked);
      if (badgeResult?.badgeUnlocked) {
        const b = badgeResult.badgeUnlocked;
        await reply.reply({ content: `${b.emoji} **Badge "${b.name}" débloqué !** +${b.reward} 🪙` }).catch(() => null);
      }

      return reply;
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha wish ═══
  @Slash({ name: 'wish', description: 'Ajoute/retire une carte de ta wishlist' })
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
    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.reply({ embeds: [serviceDownEmbed()], flags: MessageFlags.Ephemeral });
    }

    try {
      // Search for the card first
      const cards = await api.searchCards(cardName, 1);
      if (cards.length === 0) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Error)
              .setDescription(`Carte "${cardName}" introuvable. \`/gacha catalogue\``),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
      const card = cards[0]!;

      const r = await api.wishlistToggle(card.id);
      if (!r.added) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Warning)
              .setDescription(`❌ **${card.name}** retirée de ta wishlist.`),
          ],
        });
      }
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(RARITY_CONFIG[card.rarity]?.color ?? 0x3b82f6)
            .setTitle('⭐ Wishlist')
            .setDescription(
              `${RARITY_CONFIG[card.rarity]?.emoji} **${card.name}** ajoutée !\nEmbed doré quand tu la drop.`,
            )
            .setThumbnail(card.imageUrl || ''),
        ],
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.reply({ embeds: [gachaErrorEmbed(err)], flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [serviceDownEmbed()], flags: MessageFlags.Ephemeral });
    }
  }

  // ═══ /gacha wishlist ═══
  @Slash({ name: 'wishlist', description: 'Affiche ta wishlist' })
  async wishlist(interaction: CommandInteraction) {
    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.reply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const items = await api.wishlist();

      if (items.length === 0) {
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
      }

      const ownedCount = items.filter((w) => w.owned).length;
      const lines = items.map((w) => {
        const cfg = RARITY_CONFIG[w.card.rarity]!;
        const status = w.owned ? '✅' : '❌';
        return `${status} ${cfg.emoji} **${w.card.name}**${w.card.beyblade ? ` — *${w.card.beyblade}*` : ''}`;
      });

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(RPB.GoldColor)
            .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL() })
            .setTitle(`⭐ Wishlist — ${ownedCount}/${items.length} obtenues`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: '`/gacha wish <nom>` pour ajouter/retirer' }),
        ],
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.reply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.reply({ embeds: [serviceDownEmbed()] });
    }
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      // Search all cards (large limit)
      const allCards = await api.searchCards(series ?? '', 200);
      const filteredCards = series
        ? allCards.filter((c) => c.series.toLowerCase().includes(series.toLowerCase()))
        : allCards;

      if (filteredCards.length === 0) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Warning).setDescription('Aucune carte trouvée.')],
        });
      }

      // Get user inventory to check ownership
      const inv = await api.inventory({ limit: 200 });
      const ownedIds = new Set(inv.items.map((i) => i.cardId));
      const totalOwned = filteredCards.filter((c) => ownedIds.has(c.id)).length;

      // Group by series
      const bySeries: Record<string, typeof filteredCards> = {};
      for (const c of filteredCards) {
        const s = c.series.replace(/_/g, ' ');
        if (!bySeries[s]) bySeries[s] = [];
        bySeries[s]?.push(c);
      }

      const mainEmbed = new EmbedBuilder()
        .setColor(RPB.Color)
        .setTitle(`📖 Catalogue — ${filteredCards.length} cartes`)
        .setDescription(
          `Tu possèdes **${totalOwned}** / ${filteredCards.length} (${Math.round((totalOwned / filteredCards.length) * 100)}%)\nSéries : ${Object.keys(bySeries).join(' · ')}`,
        )
        .setFooter({ text: 'Filtre : /gacha catalogue série:BURST' });

      for (const [seriesName, seriesCards] of Object.entries(bySeries)) {
        const lines = seriesCards.map((c) => {
          const cfg = RARITY_CONFIG[c.rarity]!;
          const own = ownedIds.has(c.id) ? '✅' : '⬛';
          return `${own} ${cfg.emoji} **${c.name}**${c.beyblade ? ` — ${c.beyblade}` : ''}`;
        });
        const value = lines.join('\n');
        if (value.length <= 1024) {
          mainEmbed.addFields({ name: `📦 ${seriesName} (${seriesCards.length})`, value });
        } else {
          mainEmbed.addFields({
            name: `📦 ${seriesName} (${seriesCards.length})`,
            value: `${lines.slice(0, 15).join('\n')}\n*... +${lines.length - 15} cartes*`,
          });
        }
      }

      return interaction.editReply({ embeds: [mainEmbed] });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha collection ═══
  @Slash({ name: 'collection', description: 'Affiche ta collection' })
  async collection(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const inv = await api.inventory({ limit: 200 });

      if (inv.items.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Info)
              .setTitle('🃏 Collection vide')
              .setDescription('`/gacha gacha` pour commencer !'),
          ],
        });
      }

      // Try mosaic image from gacha server
      // We need internal userId — get it from the session
      const bal = await api.balance().catch(() => null);
      const totalCards = await this.prisma.gachaCard.count({ where: { isActive: true } }).catch(() => 82);
      const pct = Math.round((inv.items.length / totalCards) * 100);

      // For mosaic, we need the internal userId. We get it via the balance endpoint userId field.
      // The balance endpoint returns { userId, currency, ... }
      const balWithId = bal as (typeof bal & { userId?: string }) | null;
      const internalUserId = balWithId?.userId;

      if (internalUserId) {
        const mosaicAttachment = await fetchInventoryMosaicPng(internalUserId).catch(() => null);
        if (mosaicAttachment) {
          return interaction.editReply({ files: [mosaicAttachment] });
        }
      }

      // Fallback to embed
      const byRarity: Record<string, string[]> = {};
      for (const inv_item of inv.items) {
        const r = inv_item.card.rarity;
        if (!byRarity[r]) byRarity[r] = [];
        byRarity[r]?.push(
          `${RARITY_CONFIG[r]?.emoji} ${inv_item.card.name}${inv_item.count > 1 ? ` (x${inv_item.count})` : ''}`,
        );
      }

      const badgesList = BADGES.filter((b) => inv.items.length >= b.count).map(
        (b) => `${b.emoji} ${b.name}`,
      );

      const embed = new EmbedBuilder()
        .setColor(RPB.GoldColor)
        .setTitle(`🃏 Collection de ${interaction.user.displayName}`)
        .setDescription(`**${inv.items.length}** / ${totalCards} (${pct}%)`)
        .setThumbnail(interaction.user.displayAvatarURL());

      for (const r of ['SECRET', 'LEGENDARY', 'SUPER_RARE', 'RARE', 'COMMON']) {
        if (byRarity[r]?.length) {
          embed.addFields({
            name: `${RARITY_CONFIG[r]?.emoji} ${RARITY_CONFIG[r]?.label} (${byRarity[r]?.length})`,
            value: byRarity[r]?.join('\n') ?? '',
          });
        }
      }
      if (badgesList.length > 0) {
        embed.addFields({ name: '🏅 Badges', value: badgesList.join(' · ') });
      }

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha vendre ═══
  @Slash({ name: 'vendre', description: 'Vends un doublon' })
  async sell(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      // Get inventory to find a duplicate
      const inv = await api.inventory({ limit: 200 });
      const dup = inv.items.find((i) => i.count > 1);

      if (!dup) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Warning).setDescription('Aucun doublon à vendre.')],
        });
      }

      const result = await api.sell(dup.cardId);
      const cfg = RARITY_CONFIG[result.rarity]!;

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Success)
            .setDescription(
              `${cfg.emoji} **${result.cardName}** vendue pour **${result.pricePaid}** 🪙 · Solde : **${result.newBalance.toLocaleString('fr-FR')}** 🪙`,
            ),
        ],
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha vendre-tout ═══
  @Slash({ name: 'vendre-tout', description: "Vends TOUS tes doublons d'un coup" })
  async sellAll(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const result = await api.sellAll();

      if (result.soldCount === 0) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Warning).setDescription('Aucun doublon à vendre.')],
        });
      }

      const lines = result.sold.map((s) => {
        const cfg = RARITY_CONFIG[s.rarity]!;
        return `${cfg.emoji} ${s.name} x${s.count} → **${s.earned}** 🪙`;
      });

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Success)
            .setTitle(`💸 ${result.soldCount} doublons vendus !`)
            .setDescription(
              `${lines.join('\n')}\n\n🪙 **Total : +${result.totalEarned.toLocaleString('fr-FR')} pièces**\n💰 Solde : **${result.newBalance.toLocaleString('fr-FR')}** 🪙`,
            ),
        ],
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha classement ═══
  @Slash({ name: 'classement', description: 'Top collectionneurs et plus riches' })
  async leaderboard(interaction: CommandInteraction) {
    await interaction.deferReply();

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      // Try image from gacha server first
      const lbAttachment = await fetchLeaderboardPng('collection').catch(() => null);
      if (lbAttachment) {
        return interaction.editReply({ files: [lbAttachment] });
      }

      // Fallback: text leaderboard
      const [collectors, richest] = await Promise.all([
        api.leaderboard('collection', 10),
        api.leaderboard('currency', 5),
      ]);

      if (collectors.length === 0) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Info).setDescription("Personne n'a de cartes !")],
        });
      }

      const collectorsLines = collectors.map(
        (e, i) => `**${i + 1}.** ${e.name ?? '?'} — **${e.value}** cartes`,
      );
      const richestLines = richest.map(
        (e, i) => `**${i + 1}.** ${e.name ?? '?'} — **${e.value.toLocaleString('fr-FR')}** 🪙`,
      );

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(RPB.GoldColor)
            .setTitle('🏆 Classement Gacha')
            .addFields(
              { name: '🃏 Meilleurs Collectionneurs', value: collectorsLines.join('\n'), inline: true },
              { name: '💰 Plus Fortunés', value: richestLines.join('\n'), inline: true },
            ),
        ],
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha taux ═══
  @Slash({ name: 'taux', description: 'Mécaniques et taux' })
  async rates(interaction: CommandInteraction) {
    let total = 82;
    try {
      total = await this.prisma.gachaCard.count({ where: { isActive: true } });
    } catch {
      // ignore
    }

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
              value: '60%: 80-120 · 25%: 150-200 · 10%: 250-350 · 4%: 500-700 · 1%: 1000-1500',
              inline: true,
            },
            {
              name: '🔥 Streak',
              value: STREAK_BONUSES.map((s) => `${s.label}: +${s.bonus}🪙`).join('\n'),
              inline: true,
            },
            {
              name: '🏅 Badges',
              value: BADGES.map((b) => `${b.emoji} ${b.count}: +${b.reward}🪙`).join('\n'),
            },
          ),
      ],
    });
  }

  // ═══ /gacha admin-give — Admin only (Prisma direct — bot-only feature) ═══
  @Slash({ name: 'admin-give', description: '[ADMIN] Donner des pièces à un membre' })
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
    // Admin check — Prisma direct (bot-only role check)
    const caller = await this.prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });
    if (!caller || (caller.role !== 'admin' && caller.role !== 'superadmin')) {
      return interaction.reply({
        content: '❌ Réservé aux administrateurs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (amount === 0) {
      return interaction.reply({ content: '❌ Montant invalide.', flags: MessageFlags.Ephemeral });
    }

    // Use gacha API admin grant endpoint
    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.reply({ embeds: [serviceDownEmbed()], flags: MessageFlags.Ephemeral });
    }

    try {
      // Resolve target user's internal ID via discordId
      const targetDbUser = await this.prisma.user.findUnique({
        where: { discordId: target.id },
      });

      if (!targetDbUser) {
        // Auto-create via Prisma (same as before — ensures user exists for gacha admin grant)
        const newUser = await this.prisma.user.create({
          data: {
            discordId: target.id,
            name: target.displayName,
            email: `${target.id}@discord.rpbey.fr`,
          },
        });
        await this.prisma.profile.create({ data: { userId: newUser.id, currency: 0 } }).catch(() => null);
      }

      // Use admin grant via gacha API (uses the caller's admin session)
      const targetFinal = targetDbUser ?? await this.prisma.user.findUnique({ where: { discordId: target.id } });
      if (!targetFinal) {
        return interaction.reply({ content: '❌ Impossible de créer le compte.', flags: MessageFlags.Ephemeral });
      }

      const r = await api.adminGrant(targetFinal.id, amount, reason ?? `Par ${interaction.user.displayName}`);
      const isGive = amount > 0;

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(isGive ? Colors.Success : Colors.Warning)
            .setTitle(isGive ? '🪙 Pièces ajoutées' : '🪙 Pièces retirées')
            .setDescription(
              `${isGive ? '+' : ''}**${amount.toLocaleString('fr-FR')}** 🪙 ${isGive ? 'donnés à' : 'retirés de'} **${target.displayName}**` +
                (reason ? `\n📝 *${reason}*` : '') +
                `\n\n💰 Nouveau solde : **${r.newBalance.toLocaleString('fr-FR')}** 🪙`,
            )
            .setFooter({ text: `Par ${interaction.user.displayName}` }),
        ],
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.reply({ embeds: [gachaErrorEmbed(err)], flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [serviceDownEmbed()], flags: MessageFlags.Ephemeral });
    }
  }

  // ═══ /gacha duel — Quick card battle (Prisma direct — bot-only random battle) ═══
  // This is the ORIGINAL quick 1v1 gacha duel (not the TCG duel system from DuelCommand.ts).
  // It picks random cards from each player's inventory and simulates one fight.
  // Kept as Prisma-direct because it's a simple random match, not the async TCG flow.
  @Slash({ name: 'duel', description: 'Fais combattre une carte contre un adversaire !' })
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
    if (target.id === interaction.user.id) {
      return interaction.reply({ content: '❌ Tu ne peux pas te combattre !', flags: MessageFlags.Ephemeral });
    }
    if (target.bot) {
      return interaction.reply({ content: '❌ Pas de duel contre un bot !', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    // Resolve user A
    let userA = await this.prisma.user.findUnique({ where: { discordId: interaction.user.id } });
    if (!userA) {
      userA = await this.prisma.user.create({
        data: { discordId: interaction.user.id, name: interaction.user.displayName, email: `${interaction.user.id}@discord.rpbey.fr` },
      });
    }
    let profileA = await this.prisma.profile.findUnique({ where: { userId: userA.id } });
    if (!profileA) {
      profileA = await this.prisma.profile.create({ data: { userId: userA.id, currency: 0 } });
    }

    const invA = await this.prisma.cardInventory.findMany({ where: { userId: userA.id }, include: { card: true } });
    if (invA.length === 0) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Error).setDescription("Tu n'as aucune carte ! `/gacha gacha`")],
      });
    }

    // Resolve user B
    let userB = await this.prisma.user.findUnique({ where: { discordId: target.id } });
    if (!userB) {
      userB = await this.prisma.user.create({
        data: { discordId: target.id, name: target.displayName, email: `${target.id}@discord.rpbey.fr` },
      });
    }

    const invB = await this.prisma.cardInventory.findMany({ where: { userId: userB.id }, include: { card: true } });
    if (invB.length === 0) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Error).setDescription(`**${target.displayName}** n'a aucune carte !`)],
      });
    }

    const pickA = invA[Math.floor(Math.random() * invA.length)]?.card;
    const pickB = invB[Math.floor(Math.random() * invB.length)]?.card;
    if (!pickA || !pickB) {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    const RARITY_BONUS: Record<string, number> = { COMMON: 0, RARE: 10, SUPER_RARE: 25, LEGENDARY: 45, SECRET: 65 };
    const ELEMENT_ADV: Record<string, string[]> = { FEU: ['VENT'], VENT: ['TERRE'], TERRE: ['EAU'], EAU: ['FEU'], OMBRE: ['LUMIERE'], LUMIERE: ['OMBRE'] };

    const calcPower = (card: typeof pickA) => {
      const stats = card.att * 0.35 + card.def * 0.25 + card.end * 0.25 + card.equilibre * 0.015;
      const bonus = RARITY_BONUS[card.rarity] || 0;
      const rng = Math.random() * 20;
      return stats + bonus + rng;
    };

    let scoreA = calcPower(pickA);
    let scoreB = calcPower(pickB);
    if (ELEMENT_ADV[pickA.element]?.includes(pickB.element)) scoreA *= 1.25;
    if (ELEMENT_ADV[pickB.element]?.includes(pickA.element)) scoreB *= 1.25;

    const winner: 'A' | 'B' = scoreA >= scoreB ? 'A' : 'B';
    const finishMsgs = ['⚡ X-TREME FINISH !', '💥 BURST FINISH !', '🔄 OVER FINISH !', '🌀 SPIN FINISH !'];
    const finishMsg = finishMsgs[Math.floor(Math.random() * finishMsgs.length)]!;
    const coinReward = winner === 'A' ? Math.round(scoreA / 3) : Math.round(scoreB / 3);
    const winnerId = winner === 'A' ? userA.id : userB.id;

    await this.prisma.profile.update({
      where: { userId: winnerId },
      data: { currency: { increment: coinReward } },
    });
    await this.prisma.currencyTransaction.create({
      data: { userId: winnerId, amount: coinReward, type: 'TOURNAMENT_REWARD', note: `Duel gacha: ${pickA.name} vs ${pickB.name}` },
    });

    const winnerName = winner === 'A' ? interaction.user.displayName : target.displayName;
    const cfgA = RARITY_CONFIG[pickA.rarity]!;
    const cfgB = RARITY_CONFIG[pickB.rarity]!;

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Warning)
          .setTitle(finishMsg)
          .setDescription(
            `${cfgA.emoji} **${pickA.name}** vs ${cfgB.emoji} **${pickB.name}**\n\n🏆 **${winnerName}** gagne ! +**${coinReward}** 🪙`,
          )
          .addFields(
            { name: `${interaction.user.displayName}`, value: `Score : **${Math.round(scoreA)}**`, inline: true },
            { name: target.displayName, value: `Score : **${Math.round(scoreB)}**`, inline: true },
          ),
      ],
    });
  }

  // ═══ /gacha dette — Bot-only feature (Prisma direct) ═══
  @Slash({ name: 'dette', description: 'Consulte ta dette et les intérêts' })
  async debt(interaction: CommandInteraction) {
    let user = await this.prisma.user.findUnique({ where: { discordId: interaction.user.id } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { discordId: interaction.user.id, name: interaction.user.displayName, email: `${interaction.user.id}@discord.rpbey.fr` },
      });
    }
    const profile = await this.prisma.profile.findUnique({ where: { userId: user.id } });

    if (!profile || profile.currency >= 0) {
      const balance = profile?.currency ?? 0;
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Success)
            .setTitle('✅ Aucune dette !')
            .setDescription(`Ton solde est de **${balance.toLocaleString('fr-FR')}** 🪙\nTu n'as aucune dette. Continue comme ça !`),
        ],
      });
    }

    const debt = Math.abs(profile.currency);
    const dailyInterest = Math.round(debt * 0.15);
    const daysToRepay = Math.ceil(debt / 80);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x991b1b)
          .setTitle('🏦 Rapport de dette')
          .setThumbnail(interaction.user.displayAvatarURL())
          .addFields(
            { name: '💀 Dette totale', value: `**${debt.toLocaleString('fr-FR')}** 🪙`, inline: true },
            { name: '📈 Intérêts / daily', value: `**${dailyInterest.toLocaleString('fr-FR')}** 🪙 (15%)`, inline: true },
            { name: '📅 Jours estimés', value: `~**${daysToRepay}** jours`, inline: true },
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
          .setFooter({ text: 'Les intérêts sont prélevés sur chaque /gacha daily' }),
      ],
    });
  }

  // ═══ /gacha parier — Bot-only gamble (Prisma direct) ═══
  @Slash({ name: 'parier', description: 'Parie des pièces — quitte ou double !' })
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
    if (mise <= 0) {
      return interaction.reply({ content: '❌ Mise invalide.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    let user = await this.prisma.user.findUnique({ where: { discordId: interaction.user.id } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { discordId: interaction.user.id, name: interaction.user.displayName, email: `${interaction.user.id}@discord.rpbey.fr` },
      });
    }
    let profile = await this.prisma.profile.findUnique({ where: { userId: user.id } });
    if (!profile) {
      profile = await this.prisma.profile.create({ data: { userId: user.id, currency: 0 } });
    }

    const debtBlock = debtEmbedLocal(profile.currency);
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

    await this.prisma.profile.update({ where: { id: profile.id }, data: { currency: { decrement: mise } } });

    const roll = Math.random();
    let multiplier: number;
    let result: string;
    let color: number;
    let emoji: string;

    if (roll < 0.05) { multiplier = 5; result = '💎 SUPER JACKPOT !!!'; color = 0xef4444; emoji = '💎'; }
    else if (roll < 0.2) { multiplier = 3; result = '🎰 JACKPOT !'; color = 0xfbbf24; emoji = '🎰'; }
    else if (roll < 0.55) { multiplier = 2; result = '✅ Gagné !'; color = Colors.Success; emoji = '✅'; }
    else { multiplier = 0; result = '💀 Perdu...'; color = 0x4b5563; emoji = '💀'; }

    const gain = mise * multiplier;
    const net = gain - mise;

    if (gain > 0) {
      await this.prisma.profile.update({ where: { id: profile.id }, data: { currency: { increment: gain } } });
    }

    const newBalance = profile.currency - mise + gain;

    await this.prisma.currencyTransaction.create({
      data: { userId: user.id, amount: net, type: 'GACHA_PULL', note: `Pari: mise ${mise} → x${multiplier} (${net >= 0 ? '+' : ''}${net})` },
    });

    const beyMessages: Record<number, string[]> = {
      0: ['Ta toupie a été éjectée du stadium... tout est perdu !', 'Burst ! Ta mise est partie en fumée !', 'Ring Out ! Les pièces tombent dans le vide...', 'L-Drago a absorbé toute ta mise !'],
      2: ['Ta toupie tient bon ! Tu doubles la mise !', 'Spin Finish en ta faveur !', 'Over Finish ! Tu remportes le pot !'],
      3: ['Burst Finish critique ! Triple mise !', 'Combo dévastateur ! Le jackpot est à toi !', 'X-treme Finish ! Triple récompense !'],
      5: ['XTREME FINISH LÉGENDAIRE !!! ×5 !!!', 'TON BEY SPIRIT EXPLOSE ! QUINTUPLE MISE !!!', 'PEGASUS COSMIQUE ! GAIN ASTRONOMIQUE !!!'],
    };

    const messages = beyMessages[multiplier] || beyMessages[0]!;
    const flavorText = messages[Math.floor(Math.random() * messages.length)]!;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${emoji} ${result}`)
      .setDescription(flavorText)
      .addFields(
        { name: '🎲 Mise', value: `**${mise.toLocaleString('fr-FR')}** 🪙`, inline: true },
        {
          name: `${multiplier > 0 ? '💰' : '💀'} Résultat`,
          value: multiplier > 0
            ? `**×${multiplier}** → **+${(gain - mise).toLocaleString('fr-FR')}** 🪙`
            : `**-${mise.toLocaleString('fr-FR')}** 🪙`,
          inline: true,
        },
        { name: '🏦 Solde', value: `**${newBalance.toLocaleString('fr-FR')}** 🪙`, inline: true },
      )
      .setFooter({ text: `Probabilités : 45% ×2 · 15% ×3 · 5% ×5 · 35% perdu` });

    if (multiplier >= 3) embed.setThumbnail(interaction.user.displayAvatarURL());

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

    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const cards = await api.searchCards(cardName, 1);
      if (cards.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Error)
              .setDescription(`Carte "${cardName}" introuvable. \`/gacha catalogue\``),
          ],
        });
      }
      const card = cards[0]!;

      // Check ownership via inventory
      const inv = await api.inventory({ limit: 200 });
      const invItem = inv.items.find((i) => i.cardId === card.id);
      const owned = !!invItem;
      const count = invItem?.count ?? 0;

      // Check wishlist
      const wishlist = await api.wishlist().catch(() => []);
      const isWished = wishlist.some((w) => w.cardId === card.id);

      // Try image from gacha server
      const cardAttachment = await fetchCardPng(card.id).catch(() => null);

      const cfg = RARITY_CONFIG[card.rarity]!;
      const ELEMENT_LABELS: Record<string, string> = {
        FEU: '🔥 Feu', EAU: '💧 Eau', TERRE: '🌍 Terre', VENT: '🌪️ Vent',
        OMBRE: '🌑 Ombre', LUMIERE: '✨ Lumière', NEUTRAL: '⚪ Neutre',
      };

      const embed = new EmbedBuilder()
        .setColor(cfg.color)
        .setTitle(`${cfg.emoji} ${card.name}${card.nameJp ? ` (${card.nameJp})` : ''}`)
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
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .setFooter({ text: `Valeur de vente : ${cfg.sellPrice} 🪙` });

      if (card.imageUrl && !cardAttachment) embed.setThumbnail(card.imageUrl);

      return interaction.editReply({
        embeds: [embed],
        ...(cardAttachment ? { files: [cardAttachment] } : {}),
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha donner — Give currency to another player ═══
  // Kept as Prisma-direct because it transfers currency between players
  // and the gacha API only has a gift-card endpoint (not currency transfer).
  @Slash({ name: 'donner', description: 'Donne des pièces à un autre joueur' })
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
    if (target.id === interaction.user.id) {
      return interaction.reply({ content: '❌ Tu ne peux pas te donner des pièces !', flags: MessageFlags.Ephemeral });
    }
    if (target.bot) {
      return interaction.reply({ content: '❌ Tu ne peux pas donner à un bot !', flags: MessageFlags.Ephemeral });
    }
    if (amount <= 0) {
      return interaction.reply({ content: '❌ Montant invalide.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    let user = await this.prisma.user.findUnique({ where: { discordId: interaction.user.id } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { discordId: interaction.user.id, name: interaction.user.displayName, email: `${interaction.user.id}@discord.rpbey.fr` },
      });
    }
    let profile = await this.prisma.profile.findUnique({ where: { userId: user.id } });
    if (!profile) {
      profile = await this.prisma.profile.create({ data: { userId: user.id, currency: 0 } });
    }

    if (profile.currency < amount) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Error)
            .setTitle('❌ Fonds insuffisants')
            .setDescription(`Tu n'as que **${profile.currency.toLocaleString('fr-FR')}** 🪙`),
        ],
      });
    }

    if (profile.lastGiftSent && Date.now() - profile.lastGiftSent.getTime() < GIFT_COOLDOWN_MS) {
      const nextGift = Math.floor((profile.lastGiftSent.getTime() + GIFT_COOLDOWN_MS) / 1000);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Warning)
            .setTitle('⏳ Cooldown')
            .setDescription(`Tu pourras donner à nouveau <t:${nextGift}:R>`),
        ],
      });
    }

    let targetUser = await this.prisma.user.findUnique({ where: { discordId: target.id } });
    if (!targetUser) {
      targetUser = await this.prisma.user.create({
        data: { discordId: target.id, name: target.displayName, email: `${target.id}@discord.rpbey.fr` },
      });
    }
    let targetProfile = await this.prisma.profile.findUnique({ where: { userId: targetUser.id } });
    if (!targetProfile) {
      targetProfile = await this.prisma.profile.create({ data: { userId: targetUser.id, currency: 0 } });
    }

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: { currency: { decrement: amount }, lastGiftSent: new Date() },
    });
    await this.prisma.profile.update({
      where: { id: targetProfile.id },
      data: { currency: { increment: amount } },
    });
    await this.prisma.currencyTransaction.createMany({
      data: [
        { userId: user.id, amount: -amount, type: 'ADMIN_GIVE', note: `Don à ${target.displayName}` },
        { userId: targetUser.id, amount, type: 'ADMIN_GIVE', note: `Don de ${interaction.user.displayName}` },
      ],
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Success)
          .setTitle('🎁 Don effectué !')
          .setDescription(`**${amount.toLocaleString('fr-FR')}** 🪙 envoyés à **${target.displayName}** !`)
          .addFields(
            { name: '💰 Ton solde', value: `**${(profile.currency - amount).toLocaleString('fr-FR')}** 🪙`, inline: true },
            { name: `💰 Solde de ${target.displayName}`, value: `**${(targetProfile.currency + amount).toLocaleString('fr-FR')}** 🪙`, inline: true },
          )
          .setFooter({ text: 'Prochain don possible dans 12h' }),
      ],
    });
  }

  // ═══ /gacha echange — Trade a card with another player ═══
  // This is the legacy direct trade. The new async trade flow is via /api/trade/
  // but the slash-command user experience is kept synchronous here for simplicity.
  // Uses the gacha API trade endpoints for atomicity.
  @Slash({ name: 'echange', description: 'Échange une carte avec un autre joueur' })
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
    if (target.id === interaction.user.id) {
      return interaction.reply({ content: '❌ Tu ne peux pas échanger avec toi-même !', flags: MessageFlags.Ephemeral });
    }
    if (target.bot) {
      return interaction.reply({ content: "❌ Pas d'échange avec un bot !", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    let myApi: GachaApiClient;
    try {
      myApi = await this.api(interaction);
    } catch {
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }

    try {
      // Search for both cards
      const [myCards, theirCards] = await Promise.all([
        myApi.searchCards(myCardName, 1),
        myApi.searchCards(theirCardName, 1),
      ]);

      if (myCards.length === 0) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Error).setDescription(`Carte "${myCardName}" introuvable.`)],
        });
      }
      if (theirCards.length === 0) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Error).setDescription(`Carte "${theirCardName}" introuvable.`)],
        });
      }

      const myCard = myCards[0]!;
      const theirCard = theirCards[0]!;

      // Check I own my card
      const myInv = await myApi.inventory({ limit: 200 });
      const myInvItem = myInv.items.find((i) => i.cardId === myCard.id);
      if (!myInvItem || myInvItem.count < 1) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Error).setDescription(`Tu ne possèdes pas **${myCard.name}** !`)],
        });
      }

      // Resolve target user's internal ID
      const targetDbUser = await this.prisma.user.findUnique({ where: { discordId: target.id } });
      if (!targetDbUser) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Error).setDescription(`**${target.displayName}** n'a pas de compte gacha.`)],
        });
      }

      // Propose trade via gacha API
      const proposal = await myApi.tradePropose({
        toUserId: targetDbUser.id,
        offeredCardId: myCard.id,
        requestedCardId: theirCard.id,
      });

      const myCfg = RARITY_CONFIG[myCard.rarity]!;
      const theirCfg = RARITY_CONFIG[theirCard.rarity]!;

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Info)
            .setTitle('🔄 Proposition d\'échange envoyée !')
            .setDescription(
              `**${interaction.user.displayName}** propose de donner ${myCfg.emoji} **${myCard.name}**\n` +
                `En échange de ${theirCfg.emoji} **${theirCard.name}** de **${target.displayName}**\n\n` +
                `> ID de l'échange : \`${proposal.id.slice(-8)}\`\n` +
                `> **${target.displayName}** doit accepter ou refuser via la web app.`,
            )
            .setFooter({ text: 'Échange en attente d\'acceptation' }),
        ],
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.editReply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.editReply({ embeds: [serviceDownEmbed()] });
    }
  }

  // ═══ /gacha drop — Show active drop info ═══
  @Slash({ name: 'drop', description: 'Info sur le drop actif' })
  async dropInfo(interaction: CommandInteraction) {
    let api: GachaApiClient;
    try {
      api = await this.api(interaction);
    } catch {
      return interaction.reply({ embeds: [serviceDownEmbed()] });
    }

    try {
      const banners = await api.banners();
      const activeBanner = banners.find((b) => b.isActive);

      if (!activeBanner) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Warning)
              .setTitle('📦 Aucun drop actif')
              .setDescription("Aucun drop de cartes n'est actif actuellement. Reviens plus tard !"),
          ],
        });
      }

      // Get banner promo image
      const bannerAttachment = await fetchInventoryMosaicPng(activeBanner.id).catch(() => null);

      const endTimestamp = Math.floor(new Date(activeBanner.endDate).getTime() / 1000);

      const embed = new EmbedBuilder()
        .setColor(RPB.GoldColor)
        .setTitle(`📦 Drop ${activeBanner.season} — ${activeBanner.name}`)
        .setDescription(
          [
            `*${activeBanner.theme}*`,
            '',
            `**Fin :** <t:${endTimestamp}:R> (<t:${endTimestamp}:D>)`,
          ].join('\n'),
        )
        .setFooter({ text: 'Les cartes de ce drop apparaissent en priorité dans les tirages !' });

      if (activeBanner.imageUrl) embed.setThumbnail(activeBanner.imageUrl);

      return interaction.reply({
        embeds: [embed],
        ...(bannerAttachment ? { files: [bannerAttachment] } : {}),
      });
    } catch (err) {
      if (err instanceof GachaApiError) return interaction.reply({ embeds: [gachaErrorEmbed(err)] });
      return interaction.reply({ embeds: [serviceDownEmbed()] });
    }
  }
}
