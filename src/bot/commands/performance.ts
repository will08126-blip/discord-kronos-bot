import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { loadTrades, computeStats } from '../../performance/tracker';

export const data = new SlashCommandBuilder()
  .setName('performance')
  .setDescription('Show trading performance statistics')
  .addStringOption((opt) =>
    opt
      .setName('period')
      .setDescription('Time period (default: all-time)')
      .setRequired(false)
      .addChoices(
        { name: 'Today', value: 'today' },
        { name: 'This week', value: 'week' },
        { name: 'All time', value: 'all' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const period = (interaction.options.getString('period') ?? 'all') as 'today' | 'week' | 'all';
  await interaction.deferReply();
  const allTrades = loadTrades();

  let trades = allTrades;
  let periodLabel = 'All Time';

  if (period === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    trades = allTrades.filter((t) => new Date(t.closedAt).toISOString().slice(0, 10) === today);
    periodLabel = 'Today';
  } else if (period === 'week') {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    trades = allTrades.filter((t) => t.closedAt >= weekAgo);
    periodLabel = 'Last 7 Days';
  }

  const stats = computeStats(trades);
  // totalPnlDollar stores sum of R-multiples, not actual dollars
  const pnlStr = `${stats.totalPnlDollar >= 0 ? '+' : ''}${stats.totalPnlDollar.toFixed(2)}R`;

  const embed = new EmbedBuilder()
    .setColor(stats.totalPnlDollar >= 0 ? 0x00ff87 : 0xff4444)
    .setTitle(`📊 Performance — ${periodLabel}`)
    .addFields(
      {
        name: 'Overview',
        value: [
          `Trades: **${stats.totalTrades}**  (W: ${stats.wins}  L: ${stats.losses})`,
          `Win Rate: **${(stats.winRate * 100).toFixed(1)}%**`,
          `Total P&L: **${pnlStr}**`,
          `Profit Factor: **${stats.profitFactor.toFixed(2)}**`,
          `Avg Setup Score: **${stats.avgScore.toFixed(1)}/100**`,
        ].join('\n'),
        inline: false,
      }
    );

  // Trade-type breakdown
  const { SCALP, HYBRID, SWING } = stats.byTradeType as Record<string, { trades: number; wins: number; winRate: number }>;
  if ((SCALP?.trades ?? 0) + (HYBRID?.trades ?? 0) + (SWING?.trades ?? 0) > 0) {
    embed.addFields({
      name: 'By Type',
      value: [
        `⚡ Scalp:  ${SCALP?.trades ?? 0} trades  |  ${((SCALP?.winRate ?? 0) * 100).toFixed(0)}% WR`,
        `🔀 Hybrid: ${HYBRID?.trades ?? 0} trades  |  ${((HYBRID?.winRate ?? 0) * 100).toFixed(0)}% WR`,
        `🌊 Swing:  ${SWING?.trades ?? 0} trades  |  ${((SWING?.winRate ?? 0) * 100).toFixed(0)}% WR`,
      ].join('\n'),
      inline: false,
    });
  }

  // Strategy breakdown
  const stratLines = Object.entries(stats.byStrategy).map(
    ([name, s]) =>
      `  **${name}:** ${s.totalTrades} trades, ${(s.winRate * 100).toFixed(0)}% WR, avg score ${s.avgScore.toFixed(1)}`
  );
  if (stratLines.length > 0) {
    embed.addFields({ name: 'By Strategy', value: stratLines.join('\n'), inline: false });
  }

  embed.setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
