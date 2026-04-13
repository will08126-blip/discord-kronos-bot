import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getPaperHistory } from '../../paper/paperTrading';

export const data = new SlashCommandBuilder()
  .setName('paper-history')
  .setDescription('Show paper trading history')
  .addIntegerOption((opt) =>
    opt.setName('count').setDescription('Number of trades to show (default 10, max 25)').setMinValue(1).setMaxValue(25)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const count = interaction.options.getInteger('count') ?? 10;
    const trades = getPaperHistory(Math.min(count, 25));

    if (trades.length === 0) {
      await interaction.editReply({ content: 'No closed paper trades yet.' });
      return;
    }

    const lines: string[] = [];
    for (const trade of trades) {
      const isWin = (trade.pnlDollar ?? 0) > 0;
      const assetLabel = trade.asset.split('/')[0];
      const pnlSign = isWin ? '+' : '';
      const rSign = (trade.pnlR ?? 0) >= 0 ? '+' : '';
      const duration = trade.closeTime
        ? Math.round((new Date(trade.closeTime).getTime() - new Date(trade.openTime).getTime()) / 60000)
        : 0;
      lines.push(
        `${isWin ? '✅' : '❌'} **${assetLabel}** ${trade.direction} ` +
        `${trade.entryPrice.toFixed(4)} → ${(trade.exitPrice ?? 0).toFixed(4)} ` +
        `| P&L: **${pnlSign}$${(trade.pnlDollar ?? 0).toFixed(2)}** (${rSign}${(trade.pnlR ?? 0).toFixed(2)}R) ` +
        `| ${duration}m | ${trade.closeReason ?? ''} | Bal: $${(trade.balanceAfter ?? 0).toFixed(2)}`
      );
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📄 Paper Trade History (last ${trades.length})`)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Error: ${String(err)}` });
  }
}
