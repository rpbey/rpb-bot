import { Pagination } from '@rpbey/pagination';
import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashGroup, SlashOption } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { Colors, RPB } from '../../lib/constants.js';
import { PrismaService } from '../../lib/prisma.js';

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  STARTER: '🟢 Starter',
  BOOSTER: '🔵 Booster',
  RANDOM_BOOSTER: '🟣 Random Booster',
  SET: '📦 Set',
  DOUBLE_STARTER: '🟡 Double Starter',
  TOOL: '🔧 Tool',
  COLOR_CHOICE: '🎨 Color Choice',
};

const LINE_EMOJIS: Record<string, string> = {
  BX: '🔴',
  UX: '🔵',
  CX: '🟡',
};

@Discord()
@SlashGroup({
  name: 'produit',
  description: 'Parcourir et rechercher les produits Beyblade X',
})
@SlashGroup('produit')
@injectable()
export class ProductCommand {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  @Slash({
    name: 'rechercher',
    description: 'Rechercher un produit par nom ou code',
  })
  @SlashGroup('produit')
  async search(
    @SlashOption({
      name: 'terme',
      description: 'Nom ou code du produit à rechercher',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    query: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    const products = await this.prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { nameEn: { contains: query, mode: 'insensitive' } },
          { nameFr: { contains: query, mode: 'insensitive' } },
          { code: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { releaseDate: 'desc' },
      take: 25,
    });

    if (products.length === 0) {
      return interaction.editReply(
        `❌ Aucun produit trouvé pour « ${query} ».`,
      );
    }

    const pages = [];
    const perPage = 5;

    for (let i = 0; i < products.length; i += perPage) {
      const chunk = products.slice(i, i + perPage);
      const embed = new EmbedBuilder()
        .setTitle(`🔎 Résultats pour « ${query} »`)
        .setColor(Colors.Beyblade)
        .setFooter({
          text: `${products.length} résultat${products.length > 1 ? 's' : ''} | ${RPB.Name}`,
        });

      for (const product of chunk) {
        const lineEmoji = LINE_EMOJIS[product.productLine] ?? '⚪';
        const typeLabel =
          PRODUCT_TYPE_LABELS[product.productType] ?? product.productType;
        const price = product.price ? `${product.price}¥` : 'N/A';
        const date = product.releaseDate
          ? `<t:${Math.floor(product.releaseDate.getTime() / 1000)}:D>`
          : 'N/A';

        embed.addFields({
          name: `${lineEmoji} ${product.code} — ${product.nameFr || product.name}`,
          value: [
            `**Type :** ${typeLabel}`,
            `**Prix :** ${price} | **Sortie :** ${date}`,
            product.isLimited
              ? `⚡ **Édition limitée** ${product.limitedNote ?? ''}`
              : '',
            product.includedParts.length > 0
              ? `**Contenu :** ${product.includedParts.join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }

      pages.push({ embeds: [embed] });
    }

    if (pages.length === 1) {
      return interaction.editReply(pages[0]!);
    }

    const pagination = new Pagination(interaction, pages);
    return pagination.send();
  }

  @Slash({ name: 'info', description: "Détails complets d'un produit" })
  @SlashGroup('produit')
  async info(
    @SlashOption({
      name: 'code',
      description: 'Code du produit (ex: BX-01)',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    code: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    const product = await this.prisma.product.findFirst({
      where: {
        OR: [
          { code: { equals: code, mode: 'insensitive' } },
          { code: { contains: code, mode: 'insensitive' } },
        ],
      },
      include: {
        beyblades: {
          include: { blade: true, ratchet: true, bit: true },
        },
      },
    });

    if (!product) {
      return interaction.editReply(
        `❌ Produit « ${code} » introuvable. Essayez \`/produit rechercher\`.`,
      );
    }

    const lineEmoji = LINE_EMOJIS[product.productLine] ?? '⚪';
    const typeLabel =
      PRODUCT_TYPE_LABELS[product.productType] ?? product.productType;

    const embed = new EmbedBuilder()
      .setTitle(
        `${lineEmoji} ${product.code} — ${product.nameFr || product.name}`,
      )
      .setColor(Colors.Beyblade);

    if (product.nameEn && product.nameEn !== product.name) {
      embed.setDescription(`*${product.nameEn}*`);
    }

    embed.addFields(
      { name: '📦 Type', value: typeLabel, inline: true },
      {
        name: '🏷️ Gamme',
        value: `${lineEmoji} ${product.productLine}`,
        inline: true,
      },
      {
        name: '💴 Prix',
        value: product.price ? `${product.price}¥` : 'N/A',
        inline: true,
      },
    );

    if (product.releaseDate) {
      embed.addFields({
        name: '📅 Date de sortie',
        value: `<t:${Math.floor(product.releaseDate.getTime() / 1000)}:D>`,
        inline: true,
      });
    }

    if (product.isLimited) {
      embed.addFields({
        name: '⚡ Édition limitée',
        value: product.limitedNote || 'Oui',
        inline: true,
      });
    }

    if (product.description) {
      embed.addFields({
        name: '📝 Description',
        value: product.description.slice(0, 1024),
      });
    }

    if (product.beyblades.length > 0) {
      const beyLines = product.beyblades.map((b) => {
        return `**${b.name}** — ${b.blade.name} ${b.ratchet.name} ${b.bit.name}`;
      });
      embed.addFields({
        name: `🌀 Beyblades inclus (${product.beyblades.length})`,
        value: beyLines.join('\n').slice(0, 1024),
      });
    }

    if (product.includedParts.length > 0 && product.beyblades.length === 0) {
      embed.addFields({
        name: '🔩 Contenu',
        value: product.includedParts.join(', '),
      });
    }

    if (product.imageUrl) {
      embed.setThumbnail(
        product.imageUrl.startsWith('http')
          ? product.imageUrl
          : `https://rpbey.fr${product.imageUrl}`,
      );
    }

    embed.setFooter({ text: RPB.Name }).setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  @Slash({
    name: 'nouveautés',
    description: 'Voir les derniers produits sortis ou à venir',
  })
  @SlashGroup('produit')
  async latest(
    @SlashChoice({ name: 'BX', value: 'BX' })
    @SlashChoice({ name: 'UX', value: 'UX' })
    @SlashChoice({ name: 'CX', value: 'CX' })
    @SlashOption({
      name: 'gamme',
      description: 'Filtrer par gamme (optionnel)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    line: string | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    const where = line ? { productLine: line as 'BX' | 'UX' | 'CX' } : {};

    const products = await this.prisma.product.findMany({
      where,
      orderBy: { releaseDate: 'desc' },
      take: 10,
    });

    if (products.length === 0) {
      return interaction.editReply('❌ Aucun produit trouvé.');
    }

    const embed = new EmbedBuilder()
      .setTitle(`🆕 Derniers produits${line ? ` (${line})` : ''}`)
      .setColor(Colors.Beyblade);

    const lines = products.map((p) => {
      const emoji = LINE_EMOJIS[p.productLine] ?? '⚪';
      const date = p.releaseDate
        ? `<t:${Math.floor(p.releaseDate.getTime() / 1000)}:d>`
        : '?';
      const typeLabel = PRODUCT_TYPE_LABELS[p.productType] ?? p.productType;
      return `${emoji} **${p.code}** — ${p.nameFr || p.name}\n${typeLabel} | ${date}${p.isLimited ? ' | ⚡ Limité' : ''}`;
    });

    embed
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: RPB.Name })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }
}
