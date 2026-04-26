import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type CommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashGroup, SlashOption } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { generateDeckCard } from '../../lib/canvas-utils.js';
import { Colors } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import { PrismaService } from '../../lib/prisma.js';

const parseStat = (val: string | number | null | undefined): number => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

// Shared prisma instance for autocomplete callbacks (singleton)
let _prisma: PrismaService | null = null;
function getPrisma(): PrismaService {
  if (!_prisma) {
    // Lazy import — will be set by constructor
    throw new Error('Prisma not initialized');
  }
  return _prisma;
}

// --- Autocomplete callbacks ---
async function autocompleteParts(
  interaction: {
    options: { getFocused: () => string };
    respond: (choices: { name: string; value: string }[]) => Promise<void>;
  },
  type: string,
) {
  const query = interaction.options.getFocused().toLowerCase();
  try {
    const prisma = getPrisma();
    const parts = await prisma.part.findMany({
      where: {
        type: type as never,
        name: { contains: query, mode: 'insensitive' },
      },
      take: 25,
      orderBy: { name: 'asc' },
    });
    await interaction.respond(
      parts.map((p) => ({
        name: `${p.system ? `[${p.system}] ` : ''}${p.name}`,
        value: p.id,
      })),
    );
  } catch {
    await interaction.respond([]);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acBlade = (i: any) => autocompleteParts(i, 'BLADE');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acRatchet = (i: any) => autocompleteParts(i, 'RATCHET');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acBit = (i: any) => autocompleteParts(i, 'BIT');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acOverBlade = (i: any) => autocompleteParts(i, 'OVER_BLADE');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acLockChip = (i: any) => autocompleteParts(i, 'LOCK_CHIP');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acAssistBlade = (i: any) => autocompleteParts(i, 'ASSIST_BLADE');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acDeck = async (i: any) => {
  try {
    const prisma = getPrisma();
    const query = i.options.getFocused().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { discordId: i.user.id },
      include: { decks: true },
    });
    if (!user) return i.respond([]);
    await i.respond(
      user.decks
        .filter((d) => d.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((d) => ({
          name: `${d.isActive ? '⭐ ' : ''}${d.name}`,
          value: d.id,
        })),
    );
  } catch {
    await i.respond([]);
  }
};

// Full include for deck items
const DECK_ITEMS_INCLUDE = {
  orderBy: { position: 'asc' as const },
  include: {
    blade: true,
    overBlade: true,
    ratchet: true,
    bit: true,
    lockChip: true,
    assistBlade: true,
  },
};

const NO_ACCOUNT_MSG =
  "❌ Tu n'as pas encore de compte. Crée-le ici : https://rpbey.fr/dashboard";

@Discord()
@SlashGroup({ name: 'deck', description: 'Gestion des équipements et decks' })
@SlashGroup('deck')
@injectable()
export class DeckCommand {
  constructor(@inject(PrismaService) private prisma: PrismaService) {
    _prisma = prisma;
  }

  private async getOrCreateUser(discordId: string, displayName: string) {
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
    return user;
  }

  private async isCXBlade(partId: string): Promise<boolean> {
    const part = await this.prisma.part.findUnique({
      where: { id: partId },
      select: { system: true },
    });
    return part?.system === 'CX';
  }

  private buildDeckCardData(
    deckName: string,
    ownerName: string,
    isActive: boolean,
    items: Array<{
      blade?: {
        name: string;
        imageUrl?: string | null;
        beyType?: string | null;
        attack?: string | null;
        defense?: string | null;
        stamina?: string | null;
        system?: string | null;
      } | null;
      overBlade?: { name: string } | null;
      ratchet?: {
        name: string;
        attack?: string | null;
        defense?: string | null;
        stamina?: string | null;
      } | null;
      bit?: {
        name: string;
        attack?: string | null;
        defense?: string | null;
        stamina?: string | null;
      } | null;
      lockChip?: { name: string } | null;
      assistBlade?: { name: string } | null;
    }>,
  ) {
    return {
      name: deckName,
      ownerName,
      isActive,
      beys: items.map((item) => {
        const parts: string[] = [];
        if (item.lockChip) parts.push(item.lockChip.name);
        parts.push(item.blade?.name || '?');
        if (item.overBlade) parts.push(item.overBlade.name);
        if (item.assistBlade) parts.push(item.assistBlade.name);
        const isCX = item.blade?.system === 'CX';
        return {
          bladeName: isCX ? parts.join(' ') : item.blade?.name || '?',
          ratchetName: item.ratchet?.name || '?',
          bitName: item.bit?.name || '?',
          bladeImageUrl: item.blade?.imageUrl || null,
          beyType: item.blade?.beyType || null,
          atk:
            parseStat(item.blade?.attack) +
            parseStat(item.ratchet?.attack) +
            parseStat(item.bit?.attack),
          def:
            parseStat(item.blade?.defense) +
            parseStat(item.ratchet?.defense) +
            parseStat(item.bit?.defense),
          sta:
            parseStat(item.blade?.stamina) +
            parseStat(item.ratchet?.stamina) +
            parseStat(item.bit?.stamina),
        };
      }),
    };
  }

  // =============================================
  // /deck liste
  // =============================================
  @Slash({ name: 'liste', description: 'Afficher tes decks' })
  @SlashGroup('deck')
  async list(interaction: CommandInteraction) {
    await interaction.deferReply();
    try {
      const user = await this.prisma.user.findFirst({
        where: { discordId: interaction.user.id },
        include: {
          decks: {
            orderBy: { isActive: 'desc' },
            include: { items: DECK_ITEMS_INCLUDE },
          },
        },
      });

      if (!user) return interaction.editReply(NO_ACCOUNT_MSG);
      if (user.decks.length === 0)
        return interaction.editReply(
          "📦 Tu n'as pas de deck. Utilise `/deck creer` ou `/deck rapide`.",
        );

      const embeds: EmbedBuilder[] = [];
      const files: AttachmentBuilder[] = [];

      for (const deck of user.decks.slice(0, 5)) {
        const hasItems = deck.items.some(
          (i: { bladeId?: string | null }) => i.bladeId,
        );
        if (hasItems) {
          const buffer = await generateDeckCard(
            this.buildDeckCardData(
              deck.name,
              interaction.user.displayName,
              deck.isActive,
              deck.items,
            ),
          );
          const filename = `deck-${deck.id}.png`;
          files.push(new AttachmentBuilder(buffer, { name: filename }));
          embeds.push(
            new EmbedBuilder()
              .setColor(deck.isActive ? Colors.Primary : Colors.Secondary)
              .setImage(`attachment://${filename}`),
          );
        } else {
          embeds.push(
            new EmbedBuilder()
              .setTitle(deck.isActive ? `⭐ ${deck.name}` : deck.name)
              .setColor(Colors.Secondary)
              .setDescription(
                '*Deck vide — `/deck ajouter` ou `/deck rapide`*',
              ),
          );
        }
      }

      return interaction.editReply({
        embeds,
        files,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setLabel('Gérer en ligne')
              .setURL('https://rpbey.fr/dashboard/deck')
              .setStyle(ButtonStyle.Link),
          ),
        ],
      });
    } catch (error) {
      logger.error('[Deck] List error:', error);
      return interaction.editReply('❌ Erreur récupération.');
    }
  }

  // =============================================
  // /deck creer
  // =============================================
  @Slash({ name: 'creer', description: 'Créer un nouveau deck vide' })
  @SlashGroup('deck')
  async create(
    @SlashOption({
      name: 'nom',
      description: 'Nom du deck',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    interaction: CommandInteraction,
  ) {
    const user = await this.getOrCreateUser(
      interaction.user.id,
      interaction.user.displayName,
    );
    const count = await this.prisma.deck.count({ where: { userId: user.id } });
    if (count >= 10) return interaction.reply('❌ Max 10 decks.');
    await this.prisma.deck.create({
      data: {
        userId: user.id,
        name,
        isActive: count === 0,
        items: { create: [{ position: 1 }, { position: 2 }, { position: 3 }] },
      },
    });
    return interaction.reply(
      `✅ Deck **${name}** créé ! Ajoute des beys avec \`/deck ajouter\`.`,
    );
  }

  // =============================================
  // /deck rapide
  // =============================================
  @Slash({
    name: 'rapide',
    description: 'Créer un deck et remplir le 1er bey (supporte CX)',
  })
  @SlashGroup('deck')
  async quick(
    @SlashOption({
      name: 'nom',
      description: 'Nom du deck',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    @SlashOption({
      name: 'blade',
      description: 'Blade',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acBlade,
    })
    bladeId: string,
    @SlashOption({
      name: 'ratchet',
      description: 'Ratchet',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acRatchet,
    })
    ratchetId: string,
    @SlashOption({
      name: 'bit',
      description: 'Bit',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acBit,
    })
    bitId: string,
    @SlashOption({
      name: 'over_blade',
      description: 'Over Blade (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acOverBlade,
    })
    overBladeId: string | undefined,
    @SlashOption({
      name: 'lock_chip',
      description: 'Lock Chip (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acLockChip,
    })
    lockChipId: string | undefined,
    @SlashOption({
      name: 'assist_blade',
      description: 'Assist Blade (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acAssistBlade,
    })
    assistBladeId: string | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const user = await this.getOrCreateUser(
      interaction.user.id,
      interaction.user.displayName,
    );
    const count = await this.prisma.deck.count({ where: { userId: user.id } });
    if (count >= 10) return interaction.editReply('❌ Max 10 decks.');

    const isCX = await this.isCXBlade(bladeId);
    const slot1: Record<string, string> = { bladeId, ratchetId, bitId };
    if (isCX) {
      if (overBladeId) slot1.overBladeId = overBladeId;
      if (lockChipId) slot1.lockChipId = lockChipId;
      if (assistBladeId) slot1.assistBladeId = assistBladeId;
    }

    const deck = await this.prisma.deck.create({
      data: {
        userId: user.id,
        name,
        isActive: count === 0,
        items: {
          create: [{ position: 1, ...slot1 }, { position: 2 }, { position: 3 }],
        },
      },
      include: { items: DECK_ITEMS_INCLUDE },
    });

    const buffer = await generateDeckCard(
      this.buildDeckCardData(
        deck.name,
        interaction.user.displayName,
        deck.isActive,
        deck.items,
      ),
    );
    const filename = `deck-${deck.id}.png`;
    const cxNote = isCX
      ? '\n*Blade CX détecté — pièces Over/Chip/Assist enregistrées.*'
      : '';

    return interaction.editReply({
      content: `✅ Deck **${name}** créé !${cxNote}\nAjoute les beys 2 et 3 avec \`/deck ajouter\`.`,
      files: [new AttachmentBuilder(buffer, { name: filename })],
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Primary)
          .setImage(`attachment://${filename}`),
      ],
    });
  }

  // =============================================
  // /deck ajouter
  // =============================================
  @Slash({
    name: 'ajouter',
    description: 'Ajouter un bey au prochain slot libre (supporte CX)',
  })
  @SlashGroup('deck')
  async add(
    @SlashOption({
      name: 'blade',
      description: 'Blade',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acBlade,
    })
    bladeId: string,
    @SlashOption({
      name: 'ratchet',
      description: 'Ratchet',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acRatchet,
    })
    ratchetId: string,
    @SlashOption({
      name: 'bit',
      description: 'Bit',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acBit,
    })
    bitId: string,
    @SlashOption({
      name: 'over_blade',
      description: 'Over Blade (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acOverBlade,
    })
    overBladeId: string | undefined,
    @SlashOption({
      name: 'lock_chip',
      description: 'Lock Chip (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acLockChip,
    })
    lockChipId: string | undefined,
    @SlashOption({
      name: 'assist_blade',
      description: 'Assist Blade (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acAssistBlade,
    })
    assistBladeId: string | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    try {
      const user = await this.prisma.user.findUnique({
        where: { discordId: interaction.user.id },
        include: {
          decks: {
            where: { isActive: true },
            include: { items: { orderBy: { position: 'asc' } } },
          },
        },
      });
      if (!user?.decks[0])
        return interaction.editReply(
          '❌ Pas de deck actif. Crée-en un avec `/deck creer`.',
        );

      const deck = user.decks[0];
      const emptySlot = deck.items.find((i) => !i.bladeId);
      if (!emptySlot)
        return interaction.editReply(
          '❌ Deck plein ! Utilise `/deck modifier` pour remplacer un slot.',
        );

      // Validate parts exist before updating
      const [blade, ratchet, bit] = await Promise.all([
        this.prisma.part.findUnique({
          where: { id: bladeId },
          select: { name: true, system: true },
        }),
        this.prisma.part.findUnique({
          where: { id: ratchetId },
          select: { name: true },
        }),
        this.prisma.part.findUnique({
          where: { id: bitId },
          select: { name: true },
        }),
      ]);
      if (!blade)
        return interaction.editReply(
          "❌ Blade introuvable. Utilise l'autocomplétion.",
        );
      if (!ratchet)
        return interaction.editReply(
          "❌ Ratchet introuvable. Utilise l'autocomplétion.",
        );
      if (!bit)
        return interaction.editReply(
          "❌ Bit introuvable. Utilise l'autocomplétion.",
        );

      const isCX = blade.system === 'CX';
      const data: Record<string, string> = { bladeId, ratchetId, bitId };
      if (isCX) {
        if (overBladeId) data.overBladeId = overBladeId;
        if (lockChipId) data.lockChipId = lockChipId;
        if (assistBladeId) data.assistBladeId = assistBladeId;
      }

      await this.prisma.deckItem.update({ where: { id: emptySlot.id }, data });

      return interaction.editReply(
        `✅ **${blade.name}** ajouté au slot ${emptySlot.position} de **${deck.name}** !`,
      );
    } catch (error) {
      logger.error('[Deck] Add error:', error);
      return interaction.editReply(
        "❌ Erreur lors de l'ajout. Vérifie tes pièces.",
      );
    }
  }

  // =============================================
  // /deck modifier
  // =============================================
  @Slash({ name: 'modifier', description: 'Modifier un slot du deck actif' })
  @SlashGroup('deck')
  async edit(
    @SlashOption({
      name: 'slot',
      description: 'Position (1-3)',
      required: true,
      type: ApplicationCommandOptionType.Integer,
      minValue: 1,
      maxValue: 3,
    })
    slot: number,
    @SlashOption({
      name: 'blade',
      description: 'Blade',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acBlade,
    })
    bladeId: string,
    @SlashOption({
      name: 'ratchet',
      description: 'Ratchet',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acRatchet,
    })
    ratchetId: string,
    @SlashOption({
      name: 'bit',
      description: 'Bit',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acBit,
    })
    bitId: string,
    @SlashOption({
      name: 'over_blade',
      description: 'Over Blade (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acOverBlade,
    })
    overBladeId: string | undefined,
    @SlashOption({
      name: 'lock_chip',
      description: 'Lock Chip (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acLockChip,
    })
    lockChipId: string | undefined,
    @SlashOption({
      name: 'assist_blade',
      description: 'Assist Blade (CX)',
      required: false,
      type: ApplicationCommandOptionType.String,
      autocomplete: acAssistBlade,
    })
    assistBladeId: string | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const user = await this.prisma.user.findUnique({
      where: { discordId: interaction.user.id },
      include: {
        decks: { where: { isActive: true }, include: { items: true } },
      },
    });
    if (!user?.decks[0]) return interaction.editReply('❌ Pas de deck actif.');

    const isCX = await this.isCXBlade(bladeId);
    await this.prisma.deckItem.updateMany({
      where: { deckId: user.decks[0].id, position: slot },
      data: {
        bladeId,
        ratchetId,
        bitId,
        overBladeId: isCX && overBladeId ? overBladeId : null,
        lockChipId: isCX && lockChipId ? lockChipId : null,
        assistBladeId: isCX && assistBladeId ? assistBladeId : null,
      },
    });
    return interaction.editReply(`✅ Slot ${slot} mis à jour !`);
  }

  // =============================================
  // /deck activer
  // =============================================
  @Slash({ name: 'activer', description: 'Changer de deck actif' })
  @SlashGroup('deck')
  async activate(
    @SlashOption({
      name: 'deck',
      description: 'Le deck à activer',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acDeck,
    })
    deckId: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const user = await this.prisma.user.findUnique({
      where: { discordId: interaction.user.id },
      include: { decks: true },
    });
    if (!user) return interaction.editReply(NO_ACCOUNT_MSG);
    const deck = user.decks.find((d) => d.id === deckId);
    if (!deck) return interaction.editReply('❌ Deck introuvable.');
    await this.prisma.deck.updateMany({
      where: { userId: user.id },
      data: { isActive: false },
    });
    await this.prisma.deck.update({
      where: { id: deckId },
      data: { isActive: true },
    });
    return interaction.editReply(
      `✅ **${deck.name}** est maintenant ton deck actif !`,
    );
  }

  // =============================================
  // /deck supprimer
  // =============================================
  @Slash({ name: 'supprimer', description: 'Supprimer un deck' })
  @SlashGroup('deck')
  async remove(
    @SlashOption({
      name: 'deck',
      description: 'Le deck à supprimer',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: acDeck,
    })
    deckId: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const user = await this.prisma.user.findUnique({
      where: { discordId: interaction.user.id },
      include: { decks: true },
    });
    if (!user) return interaction.editReply(NO_ACCOUNT_MSG);
    const deck = user.decks.find((d) => d.id === deckId);
    if (!deck) return interaction.editReply('❌ Deck introuvable.');
    await this.prisma.deckItem.deleteMany({ where: { deckId } });
    await this.prisma.deck.delete({ where: { id: deckId } });
    if (deck.isActive) {
      const remaining = await this.prisma.deck.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      });
      if (remaining)
        await this.prisma.deck.update({
          where: { id: remaining.id },
          data: { isActive: true },
        });
    }
    return interaction.editReply(`🗑️ Deck **${deck.name}** supprimé.`);
  }

  // =============================================
  // /deck piece
  // =============================================
  @Slash({ name: 'piece', description: "Statistiques d'une pièce" })
  @SlashGroup('deck')
  async part(
    @SlashChoice({ name: 'Blade', value: 'BLADE' })
    @SlashChoice({ name: 'Ratchet', value: 'RATCHET' })
    @SlashChoice({ name: 'Bit', value: 'BIT' })
    @SlashChoice({ name: 'Over Blade', value: 'OVER_BLADE' })
    @SlashChoice({ name: 'Lock Chip', value: 'LOCK_CHIP' })
    @SlashChoice({ name: 'Assist Blade', value: 'ASSIST_BLADE' })
    @SlashOption({
      name: 'type',
      description: 'Type de pièce',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    type: string,
    @SlashOption({
      name: 'nom',
      description: 'Nom de la pièce',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: (interaction) => {
        const query = interaction.options.getFocused().toLowerCase();
        const t = interaction.options.getString('type') || 'BLADE';
        getPrisma()
          .part.findMany({
            where: {
              type: t as never,
              name: { contains: query, mode: 'insensitive' },
            },
            take: 25,
            orderBy: { name: 'asc' },
          })
          .then((parts) =>
            interaction.respond(
              parts.map((p) => ({
                name: `${p.system ? `[${p.system}] ` : ''}${p.name}`,
                value: p.id,
              })),
            ),
          )
          .catch(() => interaction.respond([]));
      },
    })
    partId: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const p = await this.prisma.part.findUnique({ where: { id: partId } });
    if (!p) return interaction.editReply('❌ Pièce introuvable.');

    const TYPE_COLORS: Record<string, number> = {
      BLADE: 0xdc2626,
      RATCHET: 0xfbbf24,
      BIT: 0x22c55e,
      OVER_BLADE: 0xec4899,
      LOCK_CHIP: 0x60a5fa,
      ASSIST_BLADE: 0xa855f7,
    };
    const TYPE_EMOJIS: Record<string, string> = {
      BLADE: '⚔️',
      RATCHET: '⚙️',
      BIT: '🔩',
      OVER_BLADE: '🔮',
      LOCK_CHIP: '🔒',
      ASSIST_BLADE: '🛡️',
    };

    const color = TYPE_COLORS[type] || Colors.Beyblade;
    const emoji = TYPE_EMOJIS[type] || '🌀';
    const atk = parseStat(p.attack);
    const def = parseStat(p.defense);
    const sta = parseStat(p.stamina);
    const dash = parseStat(p.dash);
    const burst = parseStat(p.burst);
    const bar = (v: number, max = 100) =>
      '█'.repeat(Math.min(Math.round((v / max) * 10), 10)) +
      '░'.repeat(10 - Math.min(Math.round((v / max) * 10), 10));

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} ${p.name}`)
      .setColor(color);
    const badges: string[] = [];
    if (p.system) badges.push(`\`${p.system}\``);
    if (p.beyType)
      badges.push(
        `${p.beyType === 'ATTACK' ? '⚔️' : p.beyType === 'DEFENSE' ? '🛡️' : p.beyType === 'STAMINA' ? '🌀' : '⚖️'} ${p.beyType}`,
      );
    if (p.spinDirection)
      badges.push(p.spinDirection === 'L' ? '↺ Left' : '↻ Right');
    if (badges.length) embed.setDescription(badges.join(' · '));

    const statLines: string[] = [];
    if (atk || def || sta) {
      statLines.push(`ATK \`${bar(atk)}\` **${atk}**`);
      statLines.push(`DEF \`${bar(def)}\` **${def}**`);
      statLines.push(`STA \`${bar(sta)}\` **${sta}**`);
    }
    if (dash) statLines.push(`DSH \`${bar(dash)}\` **${dash}**`);
    if (burst) statLines.push(`BRS \`${bar(burst)}\` **${burst}**`);
    if (statLines.length)
      embed.addFields({
        name: '📊 Statistiques',
        value: statLines.join('\n'),
        inline: false,
      });

    const infoFields: { name: string; value: string }[] = [];
    if (p.weight) infoFields.push({ name: '⚖️ Poids', value: `${p.weight}g` });
    if (p.height)
      infoFields.push({ name: '📏 Hauteur', value: `${p.height}mm` });
    if (p.tipType) infoFields.push({ name: '💎 Type', value: p.tipType });
    if (p.gearRatio) infoFields.push({ name: '⚙️ Ratio', value: p.gearRatio });
    if (p.releaseDate)
      infoFields.push({
        name: '📅 Sortie',
        value: new Date(p.releaseDate).toLocaleDateString('fr-FR'),
      });
    for (const f of infoFields) embed.addFields({ ...f, inline: true });
    if (p.imageUrl) embed.setImage(`https://rpbey.fr${p.imageUrl}`);
    embed.setFooter({ text: 'rpbey.fr/db · Données Beyblade X' });

    return interaction.editReply({ embeds: [embed] });
  }
}
