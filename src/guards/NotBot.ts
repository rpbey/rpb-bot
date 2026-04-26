import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  type ContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type SelectMenuInteraction,
} from 'discord.js';
import { type GuardFunction } from '@rpbey/discordx';

export const NotBot: GuardFunction<
  | CommandInteraction
  | AutocompleteInteraction
  | ButtonInteraction
  | SelectMenuInteraction
  | ContextMenuCommandInteraction
  | ModalSubmitInteraction
> = async (interaction, _client, next) => {
  if (!interaction.user.bot) {
    await next();
  }
};
