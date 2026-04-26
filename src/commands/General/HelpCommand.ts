import { EmbedBuilder, MessageFlags, type CommandInteraction } from "discord.js";
import { Discord, Slash } from '@rpbey/discordx';
import { injectable } from 'tsyringe';

import { Colors, RPB } from '../../lib/constants.js';

const COMMAND_CATEGORIES = [
  {
    name: '🌀 Beyblade',
    commands: [
      { name: '/beys', desc: 'Parcourir la bibliothèque Beyblade X' },
      {
        name: '/deck',
        desc: 'Gérer vos decks (liste, créer, modifier, activer, supprimer, pièce)',
      },
      { name: '/classement profil', desc: 'Voir votre profil de classement' },
      { name: '/classement top', desc: 'Top des bladers (Global/SATR)' },
      { name: '/meta', desc: 'Analyse méta (top, catégorie, combo, pièce)' },
      { name: '/wiki', desc: 'Règles et formats officiels' },
      { name: '/produit', desc: 'Rechercher des produits Beyblade X' },
    ],
  },
  {
    name: '🎰 Gacha / Économie',
    commands: [
      { name: '/gacha gacha', desc: 'Tirer une carte (50 🪙)' },
      { name: '/gacha multi', desc: 'Tirage x10 (450 🪙)' },
      { name: '/gacha daily', desc: 'Pièces quotidiennes' },
      { name: '/gacha collection', desc: 'Voir ta collection' },
      { name: '/gacha catalogue', desc: 'Toutes les cartes' },
      { name: '/gacha solde', desc: 'Profil économie' },
      { name: '/gacha vendre', desc: 'Vendre doublons' },
      { name: '/gacha donner', desc: 'Envoyer des 🪙' },
      { name: '/gacha aide', desc: 'Guide complet du gacha' },
    ],
  },
  {
    name: '⚔️ Duels TCG',
    commands: [
      {
        name: '/duel combat',
        desc: 'Duel stratégique Best of 3 (choisis 3 cartes !)',
      },
      { name: '/duel stats', desc: 'Statistiques de duel (ELO, W/L, streak)' },
      { name: '/duel classement', desc: 'Top 10 duellistes par ELO' },
      { name: '/duel historique', desc: 'Derniers duels du serveur' },
      { name: '/gacha duel', desc: 'Duel rapide (1 carte random)' },
    ],
  },
  {
    name: '🏆 Tournois',
    commands: [
      { name: '/inscription rejoindre', desc: "S'inscrire à un tournoi" },
      { name: '/inscription quitter', desc: 'Se désinscrire' },
      { name: '/inscription statut', desc: 'Vérifier son inscription' },
      { name: '/challonge lier', desc: 'Lier ton compte Challonge' },
      { name: '/live', desc: "Statut live d'un tournoi" },
    ],
  },
  {
    name: '🎮 Jeux & Fun',
    commands: [
      { name: '/jeu combat', desc: 'Combat Beyblade X simulé' },
      { name: '/jeu aleatoire', desc: 'Combo aléatoire' },
      { name: '/jeu interaction', desc: 'Stats de mentions mutuelles' },
      { name: '/jeu wanted', desc: 'Affiche WANTED' },
      { name: '/jeu fun-agrandir', desc: 'Agrandir un émoji' },
    ],
  },
  {
    name: '🔧 Utilitaires',
    commands: [
      { name: '/utilitaire membre', desc: "Infos détaillées d'un membre" },
      { name: '/utilitaire avatar', desc: 'Avatar en haute résolution' },
      { name: '/utilitaire banniere', desc: "Bannière d'un membre" },
      { name: '/utilitaire sondage', desc: 'Créer un sondage' },
      { name: '/utilitaire suggestion', desc: 'Soumettre une suggestion' },
      { name: '/utilitaire rappel', desc: 'Programmer un rappel personnel' },
      { name: '/utilitaire embed', desc: 'Créer un embed personnalisé' },
    ],
  },
  {
    name: 'ℹ️ Informations',
    commands: [
      { name: '/info bot', desc: 'Statistiques du bot' },
      { name: '/info serveur', desc: 'Infos du serveur' },
      { name: '/info staff', desc: "L'équipe RPB" },
      { name: '/info partenaire', desc: 'Nos partenaires' },
      { name: '/info promo', desc: 'Codes promos actifs' },
      { name: '/ping', desc: 'Latence du bot' },
    ],
  },
  {
    name: '🎁 Événements',
    commands: [
      { name: '/tirage créer', desc: 'Lancer un giveaway' },
      { name: '/tirage fin', desc: 'Terminer un giveaway' },
      { name: '/tirage liste', desc: 'Voir les giveaways actifs' },
    ],
  },
  {
    name: '🛡️ Modération',
    commands: [
      { name: '/ban /unban', desc: 'Bannir / Débannir' },
      { name: '/kick', desc: 'Expulser un membre' },
      { name: '/mute /unmute', desc: 'Mute / Démute' },
      { name: '/warn /warnings /unwarn', desc: 'Avertissements' },
      { name: '/clear', desc: 'Supprimer des messages (1-100)' },
      { name: '/slowmode', desc: 'Mode lent du salon' },
      { name: '/lock /unlock', desc: 'Verrouiller / Déverrouiller un salon' },
      { name: '/nickname', desc: "Changer le pseudo d'un membre" },
      { name: '/tickets', desc: 'Panneau de support' },
    ],
  },
];

@Discord()
@injectable()
export class HelpCommand {
  @Slash({
    name: 'aide',
    description: 'Affiche la liste de toutes les commandes disponibles',
  })
  async help(interaction: CommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle('📖 Commandes du RPB Bot')
      .setDescription(
        `Bienvenue sur le bot de la **${RPB.FullName}** !\nVoici toutes les commandes disponibles :`,
      )
      .setColor(Colors.Primary)
      .setThumbnail(interaction.client.user.displayAvatarURL({ size: 256 }));

    for (const category of COMMAND_CATEGORIES) {
      embed.addFields({
        name: category.name,
        value: category.commands
          .map((c) => `\`${c.name}\` — ${c.desc}`)
          .join('\n'),
      });
    }

    embed
      .setFooter({
        text: `${RPB.FullName} · rpbey.fr`,
      })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}
