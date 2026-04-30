/**
 * test/play-command.test.ts
 *
 * Bun:test suite for src/commands/General/PlayCommand.ts
 *
 *  - User NOT in voice → ephemeral reply with the "join voice" embed +
 *    one Link button (PUBLIC_PLAY_URL fallback).
 *  - User in voice → ephemeral reply with the "ready to play" embed +
 *    two Link buttons (voice deeplink + fallback URL).
 *
 * Strategy : because PlayCommand uses tsyringe @injectable + @Discord
 * decorators with `@rpbey/discordx`, instantiating the class via DI is
 * heavy. We construct the instance directly with `new PlayCommand()` and
 * call `.play(fakeInteraction)` with a hand-rolled minimal CommandInteraction.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { MessageFlags } from "discord.js";

import { PlayCommand } from "../src/commands/General/PlayCommand.js";

// ─── Mock CommandInteraction ────────────────────────────────────────────────

interface ReplyArgs {
	embeds?: Array<{
		data: {
			title?: string;
			description?: string;
			color?: number;
		};
	}>;
	components?: Array<{
		components: Array<{
			data: { label?: string; url?: string; style?: number };
		}>;
	}>;
	flags?: number;
}

function makeInteraction(opts: {
	guildId: string | null;
	voiceChannel: { id: string; name: string } | null;
}) {
	const captured: { reply: ReplyArgs | null } = { reply: null };
	const member = {
		voice: { channel: opts.voiceChannel },
	};
	const interaction = {
		guildId: opts.guildId,
		member,
		reply: mock(async (args: ReplyArgs) => {
			captured.reply = args;
		}),
	};
	return { interaction, captured };
}

beforeEach(() => {
	process.env.PUBLIC_PLAY_URL = "https://play.rpbey.fr/test-fallback";
});

describe("PlayCommand /play", () => {
	it("user NOT in voice → ephemeral 'join voice' embed + 1 fallback button", async () => {
		const cmd = new PlayCommand();
		const { interaction, captured } = makeInteraction({
			guildId: null,
			voiceChannel: null,
		});

		// Cast: minimal duck-typed CommandInteraction (we don't exercise the rest).
		await cmd.play(interaction as never);

		expect(interaction.reply).toHaveBeenCalledTimes(1);
		const args = captured.reply;
		expect(args).not.toBeNull();
		expect(args?.flags).toBe(MessageFlags.Ephemeral);

		const embed = args?.embeds?.[0]?.data;
		expect(embed?.title).toContain("Discord Activity");
		expect(embed?.description).toMatch(/voca|navigateur/i);

		// Exactly one Link button → fallback PUBLIC_PLAY_URL.
		const buttons = args?.components?.[0]?.components ?? [];
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.data.url).toBe("https://play.rpbey.fr/test-fallback");
		expect(buttons[0]?.data.label).toMatch(/navigateur/i);
	});

	it("user IN voice → 'ready to play' embed + 2 buttons (deeplink + fallback)", async () => {
		const cmd = new PlayCommand();
		const { interaction, captured } = makeInteraction({
			guildId: "guild-123",
			voiceChannel: { id: "voice-456", name: "Salon Vocal Test" },
		});

		await cmd.play(interaction as never);

		expect(interaction.reply).toHaveBeenCalledTimes(1);
		const args = captured.reply;
		expect(args?.flags).toBe(MessageFlags.Ephemeral);

		const embed = args?.embeds?.[0]?.data;
		expect(embed?.title).toMatch(/prêt à jouer/i);
		expect(embed?.description).toContain("Salon Vocal Test");

		const buttons = args?.components?.[0]?.components ?? [];
		expect(buttons).toHaveLength(2);
		// Button 1 : voice channel deeplink
		expect(buttons[0]?.data.url).toBe(
			"https://discord.com/channels/guild-123/voice-456",
		);
		// Button 2 : PUBLIC_PLAY_URL fallback
		expect(buttons[1]?.data.url).toBe("https://play.rpbey.fr/test-fallback");
	});

	it("falls back to https://play.rpbey.fr when PUBLIC_PLAY_URL is unset", async () => {
		delete process.env.PUBLIC_PLAY_URL;
		const cmd = new PlayCommand();
		const { interaction, captured } = makeInteraction({
			guildId: null,
			voiceChannel: null,
		});
		await cmd.play(interaction as never);
		const buttons = captured.reply?.components?.[0]?.components ?? [];
		expect(buttons[0]?.data.url).toBe("https://play.rpbey.fr");
	});
});
