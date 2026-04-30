import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	type CommandInteraction,
	type GuildMember,
} from "discord.js";
import { Discord, Slash } from "@rpbey/discordx";
import { injectable } from "tsyringe";

import { Colors, RPB } from "../../lib/constants.js";

/**
 * /play — invite à lancer la Discord Activity (Beyblade Gacha).
 *
 * Discord ne permet pas (encore officiellement) de "lancer" une Activity
 * depuis un slash command — l'utilisateur doit cliquer sur l'icône Activities
 * dans la barre de salon vocal. Cette commande :
 *   - vérifie qu'il est connecté à un voice channel
 *   - lui rappelle la procédure
 *   - propose un lien deeplink vers le salon vocal courant
 *   - propose un lien fallback vers la PWA (`PUBLIC_PLAY_URL`)
 *
 * Quand l'API "Send Activity Invite" sortira de preview, on pourra envoyer
 * l'invitation programmatiquement via Discord REST.
 */
@Discord()
@injectable()
export class PlayCommand {
	@Slash({
		name: "play",
		description: "Lancer Beyblade Gacha (Discord Activity)",
	})
	async play(interaction: CommandInteraction): Promise<void> {
		const member = interaction.member as GuildMember | null;
		const voice = member?.voice?.channel ?? null;
		const guildId = interaction.guildId;

		const fallbackUrl = process.env.PUBLIC_PLAY_URL ?? "https://play.rpbey.fr";

		// Cas 1 : pas en voice channel
		if (!voice || !guildId) {
			const embed = new EmbedBuilder()
				.setColor(Colors.Warning ?? RPB.Color)
				.setTitle("🎮 Beyblade Gacha — Discord Activity")
				.setDescription(
					[
						"Pour jouer en multi avec tes amis :",
						"",
						"**1.** Rejoins un salon vocal du serveur",
						"**2.** Refais `/play`",
						"",
						"Tu peux aussi jouer en solo via le navigateur (lien ci-dessous).",
					].join("\n"),
				);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setStyle(ButtonStyle.Link)
					.setLabel("Jouer dans le navigateur")
					.setURL(fallbackUrl)
					.setEmoji("🃏"),
			);

			await interaction.reply({
				embeds: [embed],
				components: [row],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Cas 2 : en voice channel — donner les instructions et un deeplink
		const channelDeeplink = `https://discord.com/channels/${guildId}/${voice.id}`;

		const embed = new EmbedBuilder()
			.setColor(RPB.Color)
			.setTitle("🎮 Beyblade Gacha — prêt à jouer !")
			.setDescription(
				[
					`Salon vocal : **${voice.name}**`,
					"",
					"**Lancement de l'Activity :**",
					"1. Clique sur l'icône **🎯 Activities** (ou **+** > *Apps*) dans la barre du salon vocal",
					"2. Choisis **Beyblade Gacha**",
					"3. Tous les membres du salon peuvent rejoindre la même partie automatiquement",
				].join("\n"),
			)
			.setFooter({
				text: "Astuce : l'Activity fonctionne sur Discord desktop, web, iOS et Android.",
			});

		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setStyle(ButtonStyle.Link)
				.setLabel("Ouvrir le salon vocal")
				.setURL(channelDeeplink)
				.setEmoji("🔊"),
			new ButtonBuilder()
				.setStyle(ButtonStyle.Link)
				.setLabel("Jouer dans le navigateur")
				.setURL(fallbackUrl)
				.setEmoji("🃏"),
		);

		await interaction.reply({
			embeds: [embed],
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	}
}
