import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getOpenPaperPositions } from '../../paper/paperTrading';
import { fetchCurrentPrice } from '../../data/marketData';
import type { Asset } from '../../types';

export const data = new SlashCommandBuilder()
  .setName('paper-positions')
  .setDescription('Show all open paper trading positions');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const positions = getOpenPaperPositions();
    if (positions.length === 0) {
      await interaction.editReply({ content: 'No paper positions currently open.' });
      return;
    }

    const lines: string[] = [];
    for (const pos of positions) {
      try {
        const currentPrice = await fetchCurrentPrice(pos.asset as Asset);
        const isLong = pos.direction === 'LONG';
        const pnlPct = isLong
          ? (currentPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - currentPrice) / pos.entryPrice;
        const pnlDollar = pnlPct * pos.positionSizeDollars * pos.leverage;
        const minutesOpen = Math.round((Date.now() - new Date(pos.openTime).getTime()) / 60000);
        const assetLabel = pos.asset.split('/')[0];
        const dirEmoji = pos.direction === 'LONG' ? '🟢' : '🔴';
        const pnlEmoji = pnlDollar >= 0 ? '✅' : '❌';
        lines.push([
          `${dirEmoji} **${assetLabel}** ${pos.direction} @ $${pos.entryPrice.toFixed(4)}`,
          `Current: $${currentPrice.toFixed(4)} | P&L: ${pnlEmoji} ${pnlDollar >= 0 ? '+' : ''}$${pnlDollar.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%)`,
          `Leverage: ${pos.leverage}x | Open: ${minutesOpen}m | SL: $${pos.stopLoss.toFixed(4)} | TP: $${pos.takeProfit.toFixed(4)}`,
        ].join('\n'));
      } catch {
        lines.push(`**${pos.asset}** — price unavailable`);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📄 Open Paper Positions (${positions.length})`)
      .setDescription(lines.join('\n\n'))
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Error: ${String(err)}` });
  }
}
