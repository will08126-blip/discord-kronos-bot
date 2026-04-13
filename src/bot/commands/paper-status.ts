import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getPaperStats } from '../../paper/paperTrading';

export const data = new SlashCommandBuilder()
  .setName('paper-status')
  .setDescription('Show paper trading account status and statistics');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const stats = getPaperStats();
    const balanceSign = stats.balanceChangePct >= 0 ? '+' : '';
    const pnlSign = stats.totalPnlDollar >= 0 ? '+' : '';
    const todaySign = stats.todayPnlDollar >= 0 ? '+' : '';
    const streakStr = stats.streakType === 'none' ? 'No trades yet'
      : `${stats.currentStreak} ${stats.streakType === 'win' ? '✅' : '❌'} in a row`;

    const embed = new EmbedBuilder()
      .setColor(stats.totalPnlDollar >= 0 ? 0x00ff87 : 0xff4444)
      .setTitle('📄 Paper Trading Status')
      .addFields(
        {
          name: '💰 Virtual Balance',
          value: [
            `Current: **$${stats.virtualBalance.toFixed(2)}**`,
            `Starting: $${stats.startingBalance.toFixed(2)}`,
            `Change: **${balanceSign}${(stats.balanceChangePct * 100).toFixed(2)}%**`,
          ].join('\n'),
          inline: true,
        },
        {
          name: '📊 Open Positions',
          value: `**${stats.openPositions}** paper trades active`,
          inline: true,
        },
        {
          name: "📅 Today's Trades",
          value: [
            `Count: **${stats.todayTrades}**`,
            `W/L: ${stats.todayWins}✅ / ${stats.todayLosses}❌`,
            `P&L: **${todaySign}$${stats.todayPnlDollar.toFixed(2)}**`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '🏆 All-Time Stats',
          value: [
            `Trades: **${stats.allTimeTrades}** | WR: **${(stats.winRate * 100).toFixed(1)}%**`,
            `Total P&L: **${pnlSign}$${stats.totalPnlDollar.toFixed(2)}**`,
            `Profit Factor: **${stats.profitFactor.toFixed(2)}**`,
            `Current Streak: **${streakStr}**`,
          ].join('\n'),
          inline: false,
        }
      )
      .setTimestamp()
      .setFooter({ text: `Last updated: ${new Date(stats.lastUpdated).toLocaleString()}` });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Error fetching paper stats: ${String(err)}` });
  }
}
