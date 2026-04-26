import { ApplicationCommandOptionType, AttachmentBuilder, EmbedBuilder, MessageFlags, type CommandInteraction, type User } from "discord.js";
import { Discord, Slash, SlashGroup, SlashOption } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { p as parseNum } from '../../lib/battle-utils.js';
import {
  type ComboCardData,
  generateBattleResultCard,
  generateComboCard,
} from '../../lib/canvas-utils.js';
import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import { resolveDataPath } from '../../lib/paths.js';
import { PrismaService } from '../../lib/prisma.js';

// ─── Static JSON Stats ─────────────────────────────────────────────────────
interface BladeJson {
  name: string;
  spin: string;
  stats: { attack: string; defense: string; stamina: string; weight: number };
}
interface RatchetJson {
  name: string;
  stats: { attack: string; defense: string; stamina: string; weight: number };
}
interface BitJson {
  name: string;
  code: string;
  stats: {
    attack: string;
    defense: string;
    stamina: string;
    dash: string;
    burst: string;
    weight: number;
    type: string;
  };
}

async function loadJsonData<T>(filename: string): Promise<T[]> {
  const file = Bun.file(resolveDataPath('cleaned', filename));
  if (await file.exists()) return file.json();
  return [];
}

const BLADE_DATA = await loadJsonData<BladeJson>('blades.json');
const RATCHET_DATA = await loadJsonData<RatchetJson>('ratchets.json');
const BIT_DATA = await loadJsonData<BitJson>('bits.json');

function normalize(name: string) {
  return name.replace(/[\s-]/g, '').toLowerCase();
}
function findBladeStats(name: string) {
  return BLADE_DATA.find((b) => normalize(b.name) === normalize(name));
}
function findRatchetStats(name: string) {
  return RATCHET_DATA.find((r) => normalize(r.name) === normalize(name));
}
function findBitStats(name: string) {
  return BIT_DATA.find(
    (b) => normalize(b.name) === normalize(name) || b.code === name,
  );
}

const FINISH_TYPES = [
  { result: 'xtreme', message: '⚡ X-TREME FINISH !', points: 3, emoji: '⚡' },
  { result: 'burst', message: '💥 BURST FINISH !', points: 2, emoji: '💥' },
  { result: 'over', message: '🔄 OVER FINISH !', points: 2, emoji: '🔄' },
  { result: 'spin', message: '🌀 SPIN FINISH !', points: 1, emoji: '🌀' },
];

interface ComboStats {
  attack: number;
  defense: number;
  stamina: number;
  dash: number;
  burst: number;
  weight: number;
}

// ─── Beyblade X Battle Simulation Engine ────────────────────────────────────
//
// Simulates a real Beyblade X battle with:
// - Type matchups (Attack > Stamina > Defense > Attack, Balance = neutral)
// - Multi-phase combat (launch → collisions → endgame)
// - Stamina drain over time based on bit type
// - Burst chance based on attack vs burst resistance
// - Xtreme dash line mechanics (dash stat = xtreme finish potential)
// - Weight advantage in collisions
// - Critical hits based on attack spikes
//

/** Type advantage multiplier: 1.25 = advantage, 0.8 = disadvantage, 1.0 = neutral */
function typeMatchup(attacker: string | null, defender: string | null): number {
  const a = attacker || 'BALANCE';
  const d = defender || 'BALANCE';
  if (a === d) return 1.0;
  if (a === 'BALANCE' || d === 'BALANCE') return 1.0;
  // Attack beats Stamina, Stamina beats Defense, Defense beats Attack
  if (a === 'ATTACK' && d === 'STAMINA') return 1.25;
  if (a === 'STAMINA' && d === 'DEFENSE') return 1.25;
  if (a === 'DEFENSE' && d === 'ATTACK') return 1.25;
  return 0.8; // disadvantage
}

interface BattleLog {
  phase: string;
  text: string;
}

interface BattleResult {
  winner: 'A' | 'B';
  finishType: (typeof FINISH_TYPES)[number];
  hpA: number;
  hpB: number;
  maxHp: number;
  log: BattleLog[];
  rounds: number;
}

function simulateBattle(
  sA: ComboStats,
  typeA: string | null,
  sB: ComboStats,
  typeB: string | null,
  nameA: string,
  nameB: string,
): BattleResult {
  const log: BattleLog[] = [];
  const MAX_ROUNDS = 12;

  // ── PHASE 1: HP Pool (stamina + defense + weight bonus) ──
  const maxHp = 200;
  let hpA = maxHp;
  let hpB = maxHp;

  // Stamina determines base endurance
  const enduranceA =
    50 + sA.stamina * 1.2 + sA.defense * 0.3 + sA.weight * 0.15;
  const enduranceB =
    50 + sB.stamina * 1.2 + sB.defense * 0.3 + sB.weight * 0.15;

  // Burst resistance (defense + weight vs attack)
  const burstResA = sA.burst + sA.defense * 0.5 + sA.weight * 0.2;
  const burstResB = sB.burst + sB.defense * 0.5 + sB.weight * 0.2;

  // ── PHASE 2: Launch (dash stat = first contact advantage) ──
  const launchA = sA.dash * 0.8 + Math.random() * 15;
  const launchB = sB.dash * 0.8 + Math.random() * 15;

  if (launchA > launchB * 1.3) {
    const dmg = 15 + Math.random() * 10;
    hpB -= dmg;
    log.push({
      phase: 'Lancement',
      text: `${nameA} prend l'avantage au lancement ! (-${Math.round(dmg)} PV)`,
    });
  } else if (launchB > launchA * 1.3) {
    const dmg = 15 + Math.random() * 10;
    hpA -= dmg;
    log.push({
      phase: 'Lancement',
      text: `${nameB} domine le lancement ! (-${Math.round(dmg)} PV)`,
    });
  } else {
    log.push({
      phase: 'Lancement',
      text: 'Lancement équilibré, les deux toupies entrent en collision !',
    });
  }

  // ── PHASE 3: Combat rounds ──
  let round = 0;
  let xtremeChanceA = 0;
  let xtremeChanceB = 0;

  while (hpA > 0 && hpB > 0 && round < MAX_ROUNDS) {
    round++;

    // Type matchup multipliers
    const matchA = typeMatchup(typeA, typeB);
    const matchB = typeMatchup(typeB, typeA);

    // ── Attack phase: each combo attacks the other ──
    const rawAtkA = sA.attack * matchA * (0.8 + Math.random() * 0.4);
    const rawAtkB = sB.attack * matchB * (0.8 + Math.random() * 0.4);

    // Defense reduces incoming damage
    const dmgToB = Math.max(
      2,
      rawAtkA - sB.defense * 0.3 * (0.7 + Math.random() * 0.6),
    );
    const dmgToA = Math.max(
      2,
      rawAtkB - sA.defense * 0.3 * (0.7 + Math.random() * 0.6),
    );

    // Weight advantage: heavier bey deals extra knockback
    const weightDiff = sA.weight - sB.weight;
    const knockbackA = weightDiff > 3 ? weightDiff * 0.5 : 0;
    const knockbackB = weightDiff < -3 ? Math.abs(weightDiff) * 0.5 : 0;

    hpB -= dmgToB + knockbackA;
    hpA -= dmgToA + knockbackB;

    // ── Critical hit (10% chance, high attack combos get bonus) ──
    if (Math.random() < 0.1 + sA.attack * 0.001) {
      const critDmg = 12 + Math.random() * 8;
      hpB -= critDmg;
      log.push({
        phase: `Tour ${round}`,
        text: `💥 ${nameA} place un coup critique ! (-${Math.round(critDmg)} PV supplémentaires)`,
      });
    }
    if (Math.random() < 0.1 + sB.attack * 0.001) {
      const critDmg = 12 + Math.random() * 8;
      hpA -= critDmg;
      log.push({
        phase: `Tour ${round}`,
        text: `💥 ${nameB} contre-attaque avec un coup critique !`,
      });
    }

    // ── Stamina drain (passive — low stamina beys lose HP faster) ──
    const drainA = Math.max(1, 8 - sA.stamina * 0.08);
    const drainB = Math.max(1, 8 - sB.stamina * 0.08);
    hpA -= drainA;
    hpB -= drainB;

    // ── Burst check: if HP is low and attack is high enough ──
    if (
      hpB < maxHp * 0.35 &&
      Math.random() < rawAtkA * 0.01 - burstResB * 0.005 + 0.05
    ) {
      hpB = -10;
      log.push({
        phase: `Tour ${round}`,
        text: `💥 ${nameA} fait BURST ${nameB} !`,
      });
      break;
    }
    if (
      hpA < maxHp * 0.35 &&
      Math.random() < rawAtkB * 0.01 - burstResA * 0.005 + 0.05
    ) {
      hpA = -10;
      log.push({
        phase: `Tour ${round}`,
        text: `💥 ${nameB} fait BURST ${nameA} !`,
      });
      break;
    }

    // ── Xtreme dash line: accumulate chance based on dash stat ──
    xtremeChanceA += sA.dash * 0.003;
    xtremeChanceB += sB.dash * 0.003;

    if (Math.random() < xtremeChanceA && hpB > 0) {
      const xtDmg = 30 + sA.dash * 0.5;
      hpB -= xtDmg;
      log.push({
        phase: `Tour ${round}`,
        text: `⚡ ${nameA} active la X-LINE ! Dash dévastateur ! (-${Math.round(xtDmg)} PV)`,
      });
      xtremeChanceA = 0;
    }
    if (Math.random() < xtremeChanceB && hpA > 0) {
      const xtDmg = 30 + sB.dash * 0.5;
      hpA -= xtDmg;
      log.push({
        phase: `Tour ${round}`,
        text: `⚡ ${nameB} active la X-LINE ! Dash dévastateur ! (-${Math.round(xtDmg)} PV)`,
      });
      xtremeChanceB = 0;
    }
  }

  // ── PHASE 4: Determine result ──
  hpA = Math.max(hpA, -10);
  hpB = Math.max(hpB, -10);

  // Endurance tiebreaker if both still alive
  if (hpA > 0 && hpB > 0) {
    // Better endurance wins spin finish
    const finalA = hpA + enduranceA * 0.2;
    const finalB = hpB + enduranceB * 0.2;
    if (finalA >= finalB) {
      hpB = 0;
    } else {
      hpA = 0;
    }
  }

  const winner: 'A' | 'B' = hpA > hpB ? 'A' : 'B';

  // Determine finish type based on how the battle ended
  const loserHp = winner === 'A' ? hpB : hpA;
  const winnerStats = winner === 'A' ? sA : sB;
  let finishType: (typeof FINISH_TYPES)[number];

  if (loserHp <= -5) {
    // Burst or Xtreme
    if (winnerStats.dash > 30 && Math.random() < 0.5) {
      finishType = FINISH_TYPES[0]!; // X-TREME
    } else {
      finishType = FINISH_TYPES[1]!; // BURST
    }
  } else if (round >= MAX_ROUNDS - 2) {
    finishType = FINISH_TYPES[3]!; // SPIN (endurance win)
  } else {
    finishType = FINISH_TYPES[2]!; // OVER
  }

  return {
    winner,
    finishType,
    hpA: Math.max(hpA, 0),
    hpB: Math.max(hpB, 0),
    maxHp,
    log,
    rounds: round,
  };
}

function computeComboStats(
  blade: BladeJson | undefined,
  ratchet: RatchetJson | undefined,
  bit: BitJson | undefined,
): ComboStats {
  return {
    attack:
      parseNum(blade?.stats.attack) +
      parseNum(ratchet?.stats.attack) +
      parseNum(bit?.stats.attack),
    defense:
      parseNum(blade?.stats.defense) +
      parseNum(ratchet?.stats.defense) +
      parseNum(bit?.stats.defense),
    stamina:
      parseNum(blade?.stats.stamina) +
      parseNum(ratchet?.stats.stamina) +
      parseNum(bit?.stats.stamina),
    dash: parseNum(bit?.stats.dash),
    burst: parseNum(bit?.stats.burst),
    weight:
      (blade?.stats.weight ?? 0) +
      (ratchet?.stats.weight ?? 0) +
      (bit?.stats.weight ?? 0),
  };
}

function getTypeColor(beyType: string | null): number {
  switch (beyType) {
    case 'ATTACK':
      return 0xef4444;
    case 'DEFENSE':
      return 0x3b82f6;
    case 'STAMINA':
      return 0x22c55e;
    case 'BALANCE':
      return 0xa855f7;
    default:
      return Colors.Beyblade;
  }
}
function getTypeEmoji(beyType: string | null): string {
  switch (beyType) {
    case 'ATTACK':
      return '⚔️';
    case 'DEFENSE':
      return '🛡️';
    case 'STAMINA':
      return '🌀';
    case 'BALANCE':
      return '⚖️';
    default:
      return '🌀';
  }
}

function statBar(value: number, max = 100): string {
  const filled = Math.round((value / max) * 10);
  return (
    '█'.repeat(Math.min(filled, 10)) + '░'.repeat(10 - Math.min(filled, 10))
  );
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ─── Combo type from deck or random ─────────────────────────────────────────
interface PlayerCombo {
  blade: { name: string; beyType: string | null; imageUrl: string | null };
  ratchet: { name: string };
  bit: { name: string };
  fromDeck: boolean;
  deckName?: string;
}

@Discord()
@SlashGroup({ name: 'jeu', description: 'Activités ludiques et Beyblade' })
@SlashGroup('jeu')
@injectable()
export class GameGroup {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  /** Get active deck combo for a discord user, or null */
  private async getPlayerCombo(discordId: string): Promise<PlayerCombo | null> {
    const user = await this.prisma.user.findUnique({ where: { discordId } });
    if (!user) return null;

    const deck = await this.prisma.deck.findFirst({
      where: { userId: user.id, isActive: true },
      include: {
        items: {
          orderBy: { position: 'asc' },
          take: 1, // Use first item from deck
          include: {
            blade: { select: { name: true, beyType: true, imageUrl: true } },
            ratchet: { select: { name: true } },
            bit: { select: { name: true } },
          },
        },
      },
    });

    if (!deck || deck.items.length === 0) return null;

    const item = deck.items[0]!;
    if (!item.blade || !item.ratchet || !item.bit) return null;

    return {
      blade: item.blade,
      ratchet: item.ratchet,
      bit: item.bit,
      fromDeck: true,
      deckName: deck.name,
    };
  }

  /** Get a random combo from DB parts */
  private async getRandomCombo(): Promise<PlayerCombo | null> {
    const blades = await this.prisma.part.findMany({
      where: { type: 'BLADE' },
    });
    const ratchets = await this.prisma.part.findMany({
      where: { type: 'RATCHET' },
    });
    const bits = await this.prisma.part.findMany({ where: { type: 'BIT' } });

    if (blades.length === 0 || ratchets.length === 0 || bits.length === 0)
      return null;

    const blade = pick(blades);
    const ratchet = pick(ratchets);
    const bit = pick(bits);

    return {
      blade: {
        name: blade.name,
        beyType: blade.beyType,
        imageUrl: blade.imageUrl,
      },
      ratchet: { name: ratchet.name },
      bit: { name: bit.name },
      fromDeck: false,
    };
  }

  // ═══ /jeu combat ═══
  @Slash({
    name: 'combat',
    description: 'Lancer un combat contre un autre blader',
  })
  @SlashGroup('jeu')
  async battle(
    @SlashOption({
      name: 'adversaire',
      description: 'Le blader à défier',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Tu ne peux pas te battre contre toi-même !',
        flags: MessageFlags.Ephemeral,
      });
    if (target.bot)
      return interaction.reply({
        content: '❌ Tu ne peux pas défier un bot !',
        flags: MessageFlags.Ephemeral,
      });

    await interaction.deferReply();

    // Get combos: deck if available, random otherwise
    const [comboA, comboB] = await Promise.all([
      this.getPlayerCombo(interaction.user.id).then(
        (c) => c || this.getRandomCombo(),
      ),
      this.getPlayerCombo(target.id).then((c) => c || this.getRandomCombo()),
    ]);

    if (!comboA || !comboB)
      return interaction.editReply(
        '❌ Pas assez de pièces en base de données.',
      );

    const statsA = computeComboStats(
      findBladeStats(comboA.blade.name),
      findRatchetStats(comboA.ratchet.name),
      findBitStats(comboA.bit.name),
    );
    const statsB = computeComboStats(
      findBladeStats(comboB.blade.name),
      findRatchetStats(comboB.ratchet.name),
      findBitStats(comboB.bit.name),
    );

    // Simulate real battle
    const _comboNameA = `${comboA.blade.name} ${comboA.ratchet.name} ${comboA.bit.name}`;
    const _comboNameB = `${comboB.blade.name} ${comboB.ratchet.name} ${comboB.bit.name}`;
    const battle = simulateBattle(
      statsA,
      comboA.blade.beyType,
      statsB,
      comboB.blade.beyType,
      interaction.user.displayName,
      target.displayName,
    );

    const winner = battle.winner === 'A' ? interaction.user : target;
    const loser = battle.winner === 'A' ? target : interaction.user;
    const winnerCombo = battle.winner === 'A' ? comboA : comboB;
    const finishType = battle.finishType;

    // Canvas battle result card
    const cnA = `${comboA.blade.name} ${comboA.ratchet.name} ${comboA.bit.name}`;
    const cnB = `${comboB.blade.name} ${comboB.ratchet.name} ${comboB.bit.name}`;
    const coinReward = finishType.points * 10;

    const cardBuffer = await generateBattleResultCard({
      winnerName: winner.displayName,
      winnerAvatarUrl: winner.displayAvatarURL({ extension: 'png', size: 256 }),
      winnerCombo: battle.winner === 'A' ? cnA : cnB,
      winnerType: winnerCombo.blade.beyType,
      loserName: loser.displayName,
      loserAvatarUrl: loser.displayAvatarURL({ extension: 'png', size: 256 }),
      loserCombo: battle.winner === 'A' ? cnB : cnA,
      loserType: (battle.winner === 'A' ? comboB : comboA).blade.beyType,
      finishMessage: finishType.message,
      hpWinner: battle.winner === 'A' ? battle.hpA : battle.hpB,
      hpLoser: battle.winner === 'A' ? battle.hpB : battle.hpA,
      maxHp: battle.maxHp,
      rounds: battle.rounds,
      coinReward,
      log: battle.log.map((l: BattleLog) => l.text),
    });

    const filename = `battle-${Date.now()}.png`;
    const attachment = new AttachmentBuilder(cardBuffer, { name: filename });

    // Update DB stats + currency rewards
    try {
      const dbWinner = await this.prisma.user.upsert({
        where: { discordId: winner.id },
        update: {},
        create: {
          discordId: winner.id,
          name: winner.displayName,
          email: `${winner.id}@discord.rpbey.fr`,
        },
      });
      await this.prisma.profile.upsert({
        where: { userId: dbWinner.id },
        update: { wins: { increment: 1 }, currency: { increment: coinReward } },
        create: { userId: dbWinner.id, wins: 1, currency: coinReward },
      });
      await this.prisma.currencyTransaction.create({
        data: {
          userId: dbWinner.id,
          amount: coinReward,
          type: 'TOURNAMENT_REWARD',
          note: `Victoire combat: ${finishType.message}`,
        },
      });

      const dbLoser = await this.prisma.user.upsert({
        where: { discordId: loser.id },
        update: {},
        create: {
          discordId: loser.id,
          name: loser.displayName,
          email: `${loser.id}@discord.rpbey.fr`,
        },
      });
      await this.prisma.profile.upsert({
        where: { userId: dbLoser.id },
        update: { losses: { increment: 1 }, currency: { increment: 5 } },
        create: { userId: dbLoser.id, losses: 1, currency: 5 },
      });
      await this.prisma.currencyTransaction.create({
        data: {
          userId: dbLoser.id,
          amount: 5,
          type: 'TOURNAMENT_REWARD',
          note: 'Participation combat',
        },
      });
    } catch (e) {
      logger.error('[Battle] DB update error:', e);
    }

    return interaction.editReply({ files: [attachment] });
  }

  // ═══ /jeu aleatoire ═══
  @Slash({
    name: 'aleatoire',
    description: 'Générer un combo Beyblade X (ou afficher ton deck)',
  })
  @SlashGroup('jeu')
  async random(interaction: CommandInteraction) {
    await interaction.deferReply();

    // Try to use active deck first
    const deckCombo = await this.getPlayerCombo(interaction.user.id);
    const combo = deckCombo || (await this.getRandomCombo());

    if (!combo)
      return interaction.editReply(
        '❌ Pas assez de pièces en base de données.',
      );

    const bladeJson = findBladeStats(combo.blade.name);
    const ratchetJson = findRatchetStats(combo.ratchet.name);
    const bitJson = findBitStats(combo.bit.name);
    const stats = computeComboStats(bladeJson, ratchetJson, bitJson);
    const comboName = `${combo.blade.name} ${combo.ratchet.name} ${combo.bit.name}`;
    const color = getTypeColor(combo.blade.beyType);

    const cardData: ComboCardData = {
      color,
      name: comboName,
      type: combo.blade.beyType || 'BALANCE',
      blade: combo.blade.name,
      ratchet: combo.ratchet.name,
      bit: combo.bit.name,
      bladeImageUrl: combo.blade.imageUrl,
      attack: stats.attack,
      defense: stats.defense,
      stamina: stats.stamina,
      dash: stats.dash,
      weight: stats.weight,
    };

    const cardBuffer = await generateComboCard(cardData);
    const filename = `combo-${Date.now()}.png`;
    const attachment = new AttachmentBuilder(cardBuffer, { name: filename });

    const bitType = bitJson?.stats.type || 'Inconnu';
    const spinDir = bladeJson?.spin === 'L' ? '↺ Gauche' : '↻ Droite';
    const source = combo.fromDeck
      ? `📦 **Deck : ${combo.deckName}**`
      : '🎲 **Combo aléatoire**';

    const embed = new EmbedBuilder()
      .setTitle(`${combo.fromDeck ? '📦' : '🎲'} ${comboName}`)
      .setDescription(
        `${getTypeEmoji(combo.blade.beyType)} **${combo.blade.beyType || 'BALANCE'}** | ${spinDir}\n${source}`,
      )
      .addFields(
        {
          name: '⚔️ Blade',
          value: [
            `**${combo.blade.name}**`,
            bladeJson
              ? `ATK ${parseNum(bladeJson.stats.attack)} | DEF ${parseNum(bladeJson.stats.defense)} | STA ${parseNum(bladeJson.stats.stamina)}`
              : '_Stats indisponibles_',
            bladeJson ? `⚖️ ${bladeJson.stats.weight}g` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          inline: true,
        },
        {
          name: '🔩 Ratchet',
          value: [
            `**${combo.ratchet.name}**`,
            ratchetJson
              ? `ATK ${parseNum(ratchetJson.stats.attack)} | DEF ${parseNum(ratchetJson.stats.defense)} | STA ${parseNum(ratchetJson.stats.stamina)}`
              : '_Stats indisponibles_',
            ratchetJson ? `⚖️ ${ratchetJson.stats.weight}g` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          inline: true,
        },
        {
          name: '💎 Bit',
          value: [
            `**${combo.bit.name}** (${bitType})`,
            bitJson
              ? `ATK ${parseNum(bitJson.stats.attack)} | DEF ${parseNum(bitJson.stats.defense)} | STA ${parseNum(bitJson.stats.stamina)}`
              : '_Stats indisponibles_',
            bitJson
              ? `DSH ${parseNum(bitJson.stats.dash)} | BRS ${parseNum(bitJson.stats.burst)}`
              : '',
            bitJson ? `⚖️ ${bitJson.stats.weight}g` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          inline: true,
        },
        {
          name: '📊 Stats Totales',
          value: [
            `ATK \`${statBar(stats.attack)}\` **${stats.attack}**`,
            `DEF \`${statBar(stats.defense)}\` **${stats.defense}**`,
            `STA \`${statBar(stats.stamina)}\` **${stats.stamina}**`,
            `DSH \`${statBar(stats.dash)}\` **${stats.dash}**`,
            `BRS \`${statBar(stats.burst)}\` **${stats.burst}**`,
            `⚖️ **${stats.weight.toFixed(1)}g**`,
          ].join('\n'),
        },
      )
      .setColor(color)
      .setImage(`attachment://${filename}`)
      .setFooter({
        text: `${RPB.FullName} | ${combo.fromDeck ? 'Ton deck actif' : '/jeu aleatoire pour un autre combo'}`,
      })
      .setTimestamp();

    if (combo.blade.imageUrl)
      embed.setThumbnail(`https://rpbey.fr${combo.blade.imageUrl}`);

    return interaction.editReply({ embeds: [embed], files: [attachment] });
  }

  // ═══ /jeu interaction ═══
  @Slash({
    name: 'interaction',
    description: 'Compter les mentions mutuelles entre deux membres',
  })
  @SlashGroup('jeu')
  async interaction(
    @SlashOption({
      name: 'membre',
      description: 'Le membre',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Choisis un autre membre que toi-même !',
        flags: MessageFlags.Ephemeral,
      });
    if (target.bot)
      return interaction.reply({
        content: '❌ Impossible de calculer avec un bot.',
        flags: MessageFlags.Ephemeral,
      });

    await interaction.deferReply();

    const { getMentions, getScanMeta } = await import('../../lib/redis.js');
    const [mentionsAtoB, mentionsBtoA, scanMeta] = await Promise.all([
      getMentions(interaction.user.id, target.id),
      getMentions(target.id, interaction.user.id),
      getScanMeta(),
    ]);
    const total = mentionsAtoB + mentionsBtoA;
    const score = Math.min(total, 100);
    const { label, color } =
      score >= 50
        ? { label: 'Inséparables', color: 0xef4444 }
        : score >= 30
          ? { label: 'Meilleurs potes', color: 0xfbbf24 }
          : score >= 15
            ? { label: 'Bons amis', color: 0x3b82f6 }
            : score >= 5
              ? { label: 'Connaissances', color: 0x8b5cf6 }
              : { label: 'Inconnus', color: 0x6b7280 };

    const { generateInteractionCard } = await import(
      '../../lib/canvas-utils.js'
    );
    const cardBuffer = await generateInteractionCard({
      userAName: interaction.user.displayName,
      userAAvatarUrl: interaction.user.displayAvatarURL({
        extension: 'png',
        size: 256,
      }),
      userBName: target.displayName,
      userBAvatarUrl: target.displayAvatarURL({ extension: 'png', size: 256 }),
      mentionsAtoB,
      mentionsBtoA,
      total,
      score,
      label,
      color,
    });

    const filename = `interaction-${Date.now()}.png`;
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setImage(`attachment://${filename}`)
          .setFooter({
            text: `${scanMeta.channelsScanned} salons · ${scanMeta.messagesScanned.toLocaleString('fr-FR')} messages analysés`,
          }),
      ],
      files: [new AttachmentBuilder(cardBuffer, { name: filename })],
    });
  }

  // ═══ /jeu wanted ═══
  @Slash({ name: 'wanted', description: 'Générer une affiche WANTED' })
  @SlashGroup('jeu')
  async wanted(
    @SlashOption({
      name: 'cible',
      description: "L'utilisateur ciblé",
      required: false,
      type: ApplicationCommandOptionType.User,
    })
    targetUser: User | undefined,
    @SlashOption({
      name: 'crime',
      description: 'Le crime commis',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    customCrime: string | undefined,
    @SlashOption({
      name: 'prime',
      description: 'Montant de la prime',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    customBounty: string | undefined,
    interaction: CommandInteraction,
  ) {
    const target = targetUser ?? interaction.user;
    await interaction.deferReply();

    const crimes = [
      'A volé toutes les Cobalt Drake du tournoi',
      'Combo trop puissant, interdit de compétition',
      "A lancé sans autorisation de l'arbitre",
      'Refuse de jouer autre chose que Shark Edge',
      'A caché un aimant dans son launcher',
      'Burst au premier tour, 12 fois de suite',
      'Dealer clandestin de Random Boosters',
      'A spoilé les prochaines sorties UX',
      'Collectionne les Beyblades sans jouer',
      'A mis du WD-40 sur son Bit',
    ];
    const bounties = [
      '500 000 B₿',
      '1 000 000 B₿',
      '2 500 000 B₿',
      '10 000 000 B₿',
      '50 000 B₿',
      '999 999 B₿',
      '7 777 777 B₿',
    ];

    const crime =
      customCrime || crimes[Math.floor(Math.random() * crimes.length)]!;
    const bounty =
      customBounty || bounties[Math.floor(Math.random() * bounties.length)]!;

    const { generateWantedImage } = await import('../../lib/canvas-utils.js');
    const buffer = await generateWantedImage(
      target.displayName,
      target.displayAvatarURL({ extension: 'png', size: 512 }),
      bounty,
      crime,
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x8b0000)
          .setImage('attachment://wanted.png')
          .setFooter({ text: `Demandé par ${interaction.user.displayName}` }),
      ],
      files: [new AttachmentBuilder(buffer, { name: 'wanted.png' })],
    });
  }

  // ═══ /jeu fun-agrandir ═══
  @Slash({ name: 'fun-agrandir', description: 'Agrandir un émoji' })
  @SlashGroup('jeu')
  async emote(
    @SlashOption({
      name: 'emoji',
      description: "L'émoji à agrandir",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    emoji: string,
    interaction: CommandInteraction,
  ) {
    const match = emoji.match(/<(a?):(\w+):(\d+)>/);
    if (!match) return interaction.reply('❌ Émoji invalide.');
    return interaction.reply(
      `https://cdn.discordapp.com/emojis/${match[3]}.${match[1] ? 'gif' : 'png'}?size=512`,
    );
  }
}
