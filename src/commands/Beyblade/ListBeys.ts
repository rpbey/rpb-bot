import { Pagination } from '@rpbey/pagination';
import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashOption } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { Colors } from '../../lib/constants.js';
import { PrismaService } from '../../lib/prisma.js';

const TYPE_META: Record<
  string,
  { color: number; emoji: string; label: string }
> = {
  ATTACK: { color: 0xef4444, emoji: '⚔️', label: 'Attaque' },
  DEFENSE: { color: 0x3b82f6, emoji: '🛡️', label: 'Défense' },
  STAMINA: { color: 0x22c55e, emoji: '🌀', label: 'Endurance' },
  BALANCE: { color: 0xa855f7, emoji: '⚖️', label: 'Équilibre' },
};

function statBar(value: number, max = 100): string {
  const filled = Math.round((value / max) * 10);
  return (
    '█'.repeat(Math.min(filled, 10)) + '░'.repeat(10 - Math.min(filled, 10))
  );
}

@Discord()
@injectable()
export class ListBeysCommand {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  @Slash({
    name: 'beys',
    description: 'Parcourir la bibliothèque Beyblade X',
  })
  async list(
    @SlashChoice({ name: '⚔️ Attaque', value: 'ATTACK' })
    @SlashChoice({ name: '🛡️ Défense', value: 'DEFENSE' })
    @SlashChoice({ name: '🌀 Endurance', value: 'STAMINA' })
    @SlashChoice({ name: '⚖️ Équilibre', value: 'BALANCE' })
    @SlashOption({
      name: 'type',
      description: 'Filtrer par type',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    beyType: string | undefined,
    @SlashOption({
      name: 'recherche',
      description: 'Rechercher par nom',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    search: string | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    const where: Record<string, unknown> = {};
    if (beyType) where.beyType = beyType;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const blades = await this.prisma.beyblade.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { blade: true, ratchet: true, bit: true },
    });

    if (blades.length === 0) {
      return interaction.editReply(
        search
          ? `❌ Aucun résultat pour "${search}".`
          : '❌ Aucune toupie trouvée.',
      );
    }

    const pageSize = 5;
    const pages = [];
    const totalPages = Math.ceil(blades.length / pageSize);

    for (let i = 0; i < blades.length; i += pageSize) {
      const current = blades.slice(i, i + pageSize);
      const pageNum = Math.floor(i / pageSize) + 1;
      const typeMeta = beyType ? TYPE_META[beyType] : null;

      const embed = new EmbedBuilder()
        .setTitle(
          typeMeta
            ? `${typeMeta.emoji} Beyblade X — ${typeMeta.label}`
            : '🌀 Beyblade X — Bibliothèque',
        )
        .setColor(typeMeta?.color ?? Colors.Beyblade)
        .setFooter({
          text: `${blades.length} toupies · Page ${pageNum}/${totalPages}`,
        });

      // Set thumbnail from first bey with image on page
      const firstImg = current.find((b) => b.blade?.imageUrl);
      if (firstImg?.blade?.imageUrl) {
        embed.setThumbnail(`https://rpbey.fr${firstImg.blade.imageUrl}`);
      }

      for (const bey of current) {
        const tm = TYPE_META[bey.beyType || ''];
        const emoji = tm?.emoji || '🌀';
        const atk = bey.totalAttack ?? 0;
        const def = bey.totalDefense ?? 0;
        const sta = bey.totalStamina ?? 0;
        const weight = bey.totalWeight ? `${bey.totalWeight}g` : '?g';

        const parts = [bey.blade?.name, bey.ratchet?.name, bey.bit?.name]
          .filter(Boolean)
          .join(' · ');

        embed.addFields({
          name: `${emoji} ${bey.name}`,
          value:
            `${parts}\n` +
            `ATK \`${statBar(atk)}\` **${atk}** · ` +
            `DEF \`${statBar(def)}\` **${def}** · ` +
            `STA \`${statBar(sta)}\` **${sta}**\n` +
            `⚖️ ${weight}`,
        });
      }

      pages.push({ embeds: [embed] });
    }

    const pagination = new Pagination(interaction, pages);
    await pagination.send();
  }
}
