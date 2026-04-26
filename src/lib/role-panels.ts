import { ButtonStyle } from 'discord.js';

import { RPB } from './constants.js';

export interface RoleButtonConfig {
  customId: string;
  label: string;
  emoji: string;
  style: ButtonStyle;
  roleKey: keyof typeof RPB.Roles;
  description?: string; // For the success message
}

export interface RolePanelConfig {
  title: string;
  description: string;
  image?: string;
  color: number;
  buttons: RoleButtonConfig[];
}

export const ROLE_PANELS: RolePanelConfig[] = [
  {
    title: 'Souhaitez-vous assister aux tournois RPB ?',
    description:
      'Choisissez votre rôle pour être notifié des tournois en tant que participant ou spectateur.',
    image: 'https://rpbey.fr/tournoi.webp',
    color: RPB.Color, // Primary Red
    buttons: [
      {
        customId: 'role-participant',
        label: 'Participant',
        emoji: '⚔️',
        style: ButtonStyle.Success,
        roleKey: 'Participant',
        description:
          'Vous serez notifié des inscriptions et débuts de tournois.',
      },
      {
        customId: 'role-spectateur',
        label: 'Spectateur',
        emoji: '👀',
        style: ButtonStyle.Secondary,
        roleKey: 'Spectateur',
        description: 'Vous serez notifié des streams et résultats de tournois.',
      },
    ],
  },
  {
    title: "Souhaitez-vous être informé de toute l'actualité ?",
    description:
      'Sélectionnez les notifications que vous souhaitez recevoir sur les différents canaux de la RPB.',
    color: RPB.GoldColor, // Secondary Gold
    buttons: [
      {
        customId: 'role-reseaux',
        label: 'Youtube, TikTok & X',
        emoji: '📱',
        style: ButtonStyle.Primary,
        roleKey: 'Reseaux',
        description:
          'Notifications pour les nouvelles vidéos et posts réseaux sociaux.',
      },
      {
        customId: 'role-events',
        label: 'Live Twitch & Évents',
        emoji: '📺',
        style: ButtonStyle.Primary,
        roleKey: 'Events',
        description:
          'Notifications pour les lives Twitch et événements spéciaux.',
      },
      {
        customId: 'role-leaks',
        label: 'Leaks Beyblade',
        emoji: '🔍',
        style: ButtonStyle.Danger,
        roleKey: 'Leaks',
        description: 'Accès aux channels de leaks et spoilers Beyblade X.',
      },
    ],
  },
  {
    title: 'Souhaitez-vous être informé lors des restocks ?',
    description:
      'Recevez une notification immédiate lorsque de nouveaux produits sont disponibles.',
    color: RPB.Color,
    buttons: [
      {
        customId: 'role-restock',
        label: 'Alerte Restock',
        emoji: '🛒',
        style: ButtonStyle.Success,
        roleKey: 'Restock',
        description: 'Notifications pour les réassorts de la boutique.',
      },
    ],
  },
  {
    title: '📜 Règles Mudae',
    description: [
      '<@&1484642536126681089>\n',
      "**1.** Comptes secondaires interdits sous peine d'être blacklist des salons bot.",
      '**2.** Un seul duel par mois.',
      "**3.** Lorsque quelqu'un roll un personnage souhaité, ce personnage ne peut pas être claim pendant 8 secondes **SAUF** par ceux qui ont souhaité ce personnage (**ET** celui qui a roll).",
      '**4.** Les conflits se règlent en 1v1 Beyblade !',
    ].join('\n'),
    color: 0x9b59b6,
    buttons: [
      {
        customId: 'role-mudae',
        label: 'Valider les règles',
        emoji: '✅',
        style: ButtonStyle.Success,
        roleKey: 'Mudae',
        description:
          'Vous avez accepté les règles Mudae et avez désormais accès aux salons.',
      },
    ],
  },
];
