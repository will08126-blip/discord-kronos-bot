import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { resetPaperTrading } from '../../paper/paperTrading';
import { logger } from '../../utils/logger';

export const data = new SlashCommandBuilder()
  .setName('paper-reset')
  .setDescription('Wipe all paper trades and reset virtual balance to $1,000 (irreversible)');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });

  try {
    const startingBalance = await resetPaperTrading();

    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle('🔄 Paper Trading Account Reset')
      .setDescription(
        [
          `The virtual paper trading account has been wiped and reset.`,
          '',
          `**New balance:** $${startingBalance.toFixed(2)}`,
          `**Trade history:** cleared`,
          `**Open positions:** forcibly closed`,
          '',
          `The bot will continue auto-trading new signals from a clean slate.`,
          `Use \`/paper-status\` to confirm the reset.`,
        ].join('\n')
      )
      .setTimestamp()
      .setFooter({ text: 'Paper trading only — no real money affected' });

    await interaction.editReply({ embeds: [embed] });
    logger.info(`[paper-reset] Account reset triggered by ${interaction.user.tag}`);
  } catch (err) {
    logger.error('paper-reset command error:', err);
    await interaction.editReply({ content: `❌ Reset failed: ${String(err)}` });
  }
}
