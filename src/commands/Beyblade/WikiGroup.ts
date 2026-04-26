import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { Discord, Slash, SlashGroup, SlashOption } from '@rpbey/discordx';
import { injectable } from 'tsyringe';

import { Colors } from '../../lib/constants.js';
import { resolveDataPath } from '../../lib/paths.js';

@Discord()
@SlashGroup({ name: 'wiki', description: 'Base de connaissances Beyblade X' })
@SlashGroup('wiki')
@injectable()
export class WikiGroup {
  @Slash({ name: 'regles', description: 'Rechercher un point de règle' })
  @SlashGroup('wiki')
  async rules(
    @SlashOption({
      name: 'sujet',
      description: 'Ex: faute, burst, lancer',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    query: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    try {
      const file = Bun.file(resolveDataPath('wbo_rules.json'));
      if (!(await file.exists()))
        return interaction.editReply('❌ Base de données indisponible.');
      const data = await file.json();
      const paragraphs = (data.translatedMarkdown || data.markdown).split('\n');
      const match = paragraphs.find((p: string) =>
        p.toLowerCase().includes(query.toLowerCase()),
      );
      if (!match)
        return interaction.editReply(`❌ Aucun résultat pour "${query}".`);

      const embed = new EmbedBuilder()
        .setTitle(`📖 Wiki : ${query}`)
        .setDescription(
          match.length > 1000 ? `${match.substring(0, 1000)}...` : match,
        )
        .setColor(Colors.Info)
        .setFooter({ text: 'Source: worldbeyblade.org' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch {
      return interaction.editReply(
        '❌ Erreur lors de la lecture de la base de règles. Le fichier est peut-être corrompu.',
      );
    }
  }

  @Slash({ name: 'formats', description: 'Formats de tournoi officiels' })
  @SlashGroup('wiki')
  async formats(interaction: CommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle('🏆 Formats de Tournoi RPB')
      .setColor(Colors.Secondary)
      .setDescription(
        'Voici les formats utilisés lors des tournois organisés par la RPB et ses partenaires.',
      )
      .addFields(
        {
          name: '⚔️ 3on3 (Standard)',
          value:
            'Chaque joueur prépare un deck de **3 Beyblades**. Format le plus courant en compétition.\n' +
            '• Double Élimination (bracket Winners + Losers)\n' +
            '• First to 3 points par match',
          inline: false,
        },
        {
          name: '🎯 1on1',
          value:
            'Un seul Beyblade par joueur. Teste la maîtrise technique pure.\n' +
            '• First to 5 points\n' +
            '• Changement de combo autorisé entre les rounds',
          inline: false,
        },
        {
          name: '🔒 Deck Limited',
          value:
            'Format avec restrictions sur certaines pièces méta.\n' +
            '• Banlist mise à jour chaque saison\n' +
            '• Encourage la diversité des combos',
          inline: false,
        },
        {
          name: '🔄 Round Robin',
          value:
            "Tous les joueurs s'affrontent entre eux.\n" +
            '• Classement par victoires/défaites\n' +
            '• Idéal pour les petits groupes (8-16 joueurs)',
          inline: false,
        },
      )
      .setFooter({
        text: 'Règlement complet sur rpbey.fr/reglement',
      })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }
}
