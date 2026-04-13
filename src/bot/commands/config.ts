import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { config } from '../../config';
import { getMinScoreThreshold } from '../../adaptation/adaptation';

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Show current bot configuration settings');

export async function execute(interaction: ChatInputCommandInteraction) {
  const activeThreshold = getMinScoreThreshold();
  const filterMode =
    activeThreshold >= 75 ? '🔒 Strict (ELITE only)'
    : activeThreshold >= 60 ? '⚖️ Normal (STRONG + ELITE)'
    : '🔓 Relaxed (MEDIUM + STRONG + ELITE)';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('⚙️ Bot Configuration')
    .addFields(
      {
        name: '📈 Assets Monitored',
        value: config.trading.assets.join('\n'),
        inline: false,
      },
      {
        name: '🔁 Scan Engine',
        value: [
          `Scan interval: **${config.engine.scanIntervalMinutes} min**`,
          `Signal filter: **${filterMode}**  (score ≥ ${activeThreshold})  — change with \`/filter\``,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🛡️ Risk Controls',
        value: [
          `Max open positions: **${config.trading.maxOpenPositions}**`,
          `Daily loss limit: **$${config.trading.maxDailyLoss}**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '⚡ Leverage Caps',
        value: [
          `Scalp — ELITE: ${config.leverageTiers.scalp.ELITE}x | STRONG: ${config.leverageTiers.scalp.STRONG}x | MEDIUM: ${config.leverageTiers.scalp.MEDIUM}x`,
          `Swing — ELITE: ${config.leverageTiers.swing.ELITE}x | STRONG: ${config.leverageTiers.swing.STRONG}x | MEDIUM: ${config.leverageTiers.swing.MEDIUM}x`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🎯 Score Tiers',
        value: [
          `ELITE: ≥ ${config.scoreTiers.ELITE}`,
          `STRONG: ≥ ${config.scoreTiers.STRONG}`,
          `MEDIUM: ≥ ${config.scoreTiers.MEDIUM}`,
        ].join('  |  '),
        inline: false,
      },
      {
        name: '🤖 AI Summaries',
        value: process.env.ANTHROPIC_API_KEY ? '✅ Enabled (ANTHROPIC_API_KEY set)' : '❌ Disabled (no ANTHROPIC_API_KEY)',
        inline: false,
      }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
