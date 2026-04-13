import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getAllActivePositions } from '../../signals/signalManager';
import { formatPrice, formatPct } from '../../risk/riskCalculator';

export const data = new SlashCommandBuilder()
  .setName('positions')
  .setDescription('List all currently tracked (confirmed) positions');

export async function execute(interaction: ChatInputCommandInteraction) {
  // Use reply() directly — getAllActivePositions() is a synchronous in-memory read,
  // so this completes in <1ms, well within the 3-second interaction window.
  const positions = getAllActivePositions();

  if (positions.length === 0) {
    await interaction.reply({
      content: [
        '📭 **No confirmed positions tracked.**',
        '',
        'To track a trade, click the **✅ Entered LONG** or **✅ Entered SHORT** button',
        'under any signal posted in this channel — the bot will then monitor it for you.',
        '',
        'Use `/status` to see the full bot status.',
      ].join('\n'),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x8888ff)
    .setTitle(`📋 Active Positions (${positions.length})`)
    .setDescription('Use the **Close** buttons below to manually exit a trade.')
    .setTimestamp();

  for (const pos of positions) {
    const asset = pos.signal.asset.split('/')[0];
    const isLong = pos.signal.direction === 'LONG';
    const held = Math.round((Date.now() - pos.confirmedAt) / 60000);

    // Live P&L from entry — no price fetch, use last known values
    const pnlPct = isLong
      ? (pos.highestPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - pos.lowestPrice) / pos.entryPrice;
    const stopDist = Math.abs(pos.entryPrice - pos.currentStopLoss) / pos.entryPrice;
    const rMultiple = stopDist > 0 ? pnlPct / stopDist : 0;
    const capitalReturn = pnlPct * pos.suggestedLeverage;

    const pnlLine = `P&L peak: **${formatPct(pnlPct)}** (${rMultiple.toFixed(1)}R) | Capital: **${formatPct(capitalReturn)}**`;

    embed.addFields({
      name: `${isLong ? '🟢' : '🔴'} ${asset} ${pos.signal.direction}  (ID: ${pos.id.slice(0, 8)})`,
      value: [
        `Entry: **${formatPrice(pos.entryPrice, asset)}**  |  Held: ${held} min`,
        `SL: ${formatPrice(pos.currentStopLoss, asset)}${pos.currentStopLoss !== pos.signal.stopLoss ? ' *(trailing)*' : ''}`,
        `TP: ${formatPrice(pos.currentTakeProfit, asset)}${pos.currentTakeProfit !== pos.signal.takeProfit ? ' *(extended)*' : ''}`,
        `Lev: **${pos.suggestedLeverage}x**  |  Type: ${pos.signal.tradeType}  |  Score: ${pos.signal.score}`,
        pnlLine,
      ].join('\n'),
      inline: false,
    });
  }

  // One close button per position — use array form of addComponents (v14-safe)
  const buttons = positions.map((pos) =>
    new ButtonBuilder()
      .setCustomId(`closePosition:${pos.id}`)
      .setLabel(`Close ${pos.signal.asset.split('/')[0]}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔴')
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  await interaction.reply({ embeds: [embed], components: [row] });
}
