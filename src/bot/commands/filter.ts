import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { setMinScoreThreshold, getMinScoreThreshold } from '../../adaptation/adaptation';

const PRESETS = {
  strict:  { threshold: 75, label: 'Strict',  emoji: '🔒', tier: 'ELITE only',              desc: 'Highest-conviction setups only. Expect 1–3 signals per day at most.' },
  normal:  { threshold: 60, label: 'Normal',  emoji: '⚖️', tier: 'STRONG + ELITE',          desc: 'Balanced default. Good quality with reasonable frequency.' },
  relaxed: { threshold: 45, label: 'Relaxed', emoji: '🔓', tier: 'MEDIUM + STRONG + ELITE', desc: 'All qualifying setups. More signals, lower average conviction.' },
} as const;

export const data = new SlashCommandBuilder()
  .setName('filter')
  .setDescription('Control how often signals appear by adjusting the minimum quality threshold')
  .addStringOption((opt) =>
    opt
      .setName('mode')
      .setDescription('Signal sensitivity preset (optional if score is provided)')
      .setRequired(false)
      .addChoices(
        { name: '🔒 Strict  — ELITE only (score ≥ 75),  fewest signals',  value: 'strict'  },
        { name: '⚖️ Normal  — STRONG + ELITE (score ≥ 60), default',       value: 'normal'  },
        { name: '🔓 Relaxed — all setups (score ≥ 45),   most signals',    value: 'relaxed' },
      )
  )
  .addIntegerOption((opt) =>
    opt
      .setName('score')
      .setDescription('Exact minimum score threshold (1–100) — overrides mode when provided')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(100)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const mode        = interaction.options.getString('mode') as keyof typeof PRESETS | null;
  const customScore = interaction.options.getInteger('score');

  if (mode === null && customScore === null) {
    await interaction.reply({
      content: '❌ Please provide a **mode** preset, a **score** value, or both.',
      ephemeral: true,
    });
    return;
  }

  let threshold: number;
  let embedColor: number;
  let title: string;
  let description: string;
  let tierValue: string;
  let whatChanges: string;

  if (customScore !== null) {
    threshold   = customScore;
    embedColor  = 0x5865f2;
    title       = `🎯 Signal Filter — Custom (score ≥ ${customScore})`;
    description = mode
      ? `Custom threshold based on the **${PRESETS[mode].label}** preset. Exact value set by you.`
      : 'Custom threshold set directly. Signals scoring below this value will not appear in #bot-signals or #paper-trading.';
    tierValue   = threshold >= 80 ? 'ELITE only'
                : threshold >= 60 ? 'STRONG + ELITE'
                : threshold >= 45 ? 'MEDIUM + STRONG + ELITE'
                : 'All signals';
    whatChanges = `Only signals scoring **${threshold}** or higher will appear in #bot-signals or #paper-trading.`;
  } else {
    const preset = PRESETS[mode!];
    threshold    = preset.threshold;
    embedColor   = mode === 'strict' ? 0xff6600 : mode === 'relaxed' ? 0x00cc44 : 0x5865f2;
    title        = `${preset.emoji} Signal Filter — ${preset.label}`;
    description  = preset.desc;
    tierValue    = preset.tier;
    whatChanges  = mode === 'strict'
      ? 'Only 🏆 ELITE signals (score 80–100) will appear in #bot-signals or #paper-trading. Rare but very high quality.'
      : mode === 'relaxed'
      ? '⚡ MEDIUM signals (score 45–59) are now included alongside STRONG and ELITE in both channels. Expect more activity.'
      : '💪 Back to the default. STRONG (60–79) and ELITE (80–100) signals appear in both channels.';
  }

  setMinScoreThreshold(threshold);
  const currentThreshold = getMinScoreThreshold();

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(title)
    .setDescription(description)
    .addFields(
      {
        name: 'Threshold',
        value: `Score ≥ **${currentThreshold}** / 100`,
        inline: true,
      },
      {
        name: 'Tiers Posted',
        value: `**${tierValue}**`,
        inline: true,
      },
      {
        name: 'What changes',
        value: whatChanges,
        inline: false,
      }
    )
    .setFooter({ text: 'Setting persists across restarts — use /filter again to change it' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
