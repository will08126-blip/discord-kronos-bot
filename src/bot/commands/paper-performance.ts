import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getPaperTradesByPeriod, getPaperBalanceJourney, loadPaperTrades } from '../../paper/paperTrading';

export const data = new SlashCommandBuilder()
  .setName('paper-performance')
  .setDescription('Detailed paper trading performance breakdown')
  .addStringOption((opt) =>
    opt.setName('period')
      .setDescription('Time period (daily, weekly, all)')
      .addChoices(
        { name: 'Daily', value: 'daily' },
        { name: 'Weekly', value: 'weekly' },
        { name: 'All Time', value: 'all' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const period = (interaction.options.getString('period') ?? 'weekly') as 'daily' | 'weekly' | 'all';
    const trades = getPaperTradesByPeriod(period);
    const journey = getPaperBalanceJourney();

    const wins = trades.filter((t) => (t.pnlDollar ?? 0) > 0);
    const losses = trades.filter((t) => (t.pnlDollar ?? 0) <= 0);
    const grossProfit = wins.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnlDollar ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const totalPnl = grossProfit - grossLoss;

    // Max drawdown
    let peak = 0;
    let maxDD = 0;
    let runningBalance = journey.starting;
    for (const t of trades) {
      runningBalance += t.pnlDollar ?? 0;
      if (runningBalance > peak) peak = runningBalance;
      const dd = peak - runningBalance;
      if (dd > maxDD) maxDD = dd;
    }

    // By strategy
    const byStrategy: Record<string, { pnl: number; wins: number; losses: number; rTotal: number }> = {};
    for (const t of trades) {
      const s = t.strategy;
      if (!byStrategy[s]) byStrategy[s] = { pnl: 0, wins: 0, losses: 0, rTotal: 0 };
      byStrategy[s].pnl += t.pnlDollar ?? 0;
      byStrategy[s].rTotal += t.pnlR ?? 0;
      if ((t.pnlDollar ?? 0) > 0) byStrategy[s].wins++;
      else byStrategy[s].losses++;
    }

    // By asset
    const byAsset: Record<string, { pnl: number; count: number }> = {};
    for (const t of trades) {
      const a = t.asset.split('/')[0];
      if (!byAsset[a]) byAsset[a] = { pnl: 0, count: 0 };
      byAsset[a].pnl += t.pnlDollar ?? 0;
      byAsset[a].count++;
    }
    const sortedAssets = Object.entries(byAsset).sort((a, b) => b[1].pnl - a[1].pnl);
    const top3Assets = sortedAssets.slice(0, 3);
    const worst3Assets = sortedAssets.slice(-3).reverse();

    // Scalp vs Swing
    const scalpTrades = trades.filter((t) => t.tradeType === 'SCALP');
    const swingTrades = trades.filter((t) => t.tradeType === 'SWING' || t.tradeType === 'HYBRID');
    const scalpWins = scalpTrades.filter((t) => (t.pnlDollar ?? 0) > 0);
    const swingWins = swingTrades.filter((t) => (t.pnlDollar ?? 0) > 0);

    const embed = new EmbedBuilder()
      .setColor(totalPnl >= 0 ? 0x00ff87 : 0xff4444)
      .setTitle(`📊 Paper Performance — ${period === 'daily' ? 'Today' : period === 'weekly' ? 'Last 7 Days' : 'All Time'}`)
      .addFields(
        {
          name: '📈 Overall',
          value: trades.length === 0 ? 'No trades in this period.' : [
            `Trades: **${trades.length}** | WR: **${(wins.length / trades.length * 100).toFixed(1)}%**`,
            `Total P&L: **${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}**`,
            `Profit Factor: **${profitFactor.toFixed(2)}** | Max DD: **$${maxDD.toFixed(2)}**`,
            `Avg Win: $${avgWin.toFixed(2)} | Avg Loss: $${avgLoss.toFixed(2)}`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '🎯 By Strategy',
          value: Object.keys(byStrategy).length === 0 ? 'No data' : Object.entries(byStrategy)
            .map(([name, s]) => {
              const total = s.wins + s.losses;
              const wr = total > 0 ? (s.wins / total * 100).toFixed(0) : '0';
              const avgR = total > 0 ? (s.rTotal / total).toFixed(2) : '0';
              return `**${name}:** ${wr}% WR | avg ${avgR}R | $${s.pnl.toFixed(2)}`;
            }).join('\n'),
          inline: false,
        },
        {
          name: '🏆 Top Assets',
          value: top3Assets.length === 0 ? 'No data' : top3Assets.map(([a, d]) => `**${a}:** +$${d.pnl.toFixed(2)} (${d.count} trades)`).join('\n'),
          inline: true,
        },
        {
          name: '📉 Worst Assets',
          value: worst3Assets.length === 0 ? 'No data' : worst3Assets.map(([a, d]) => `**${a}:** $${d.pnl.toFixed(2)} (${d.count} trades)`).join('\n'),
          inline: true,
        },
        {
          name: '⚡ Scalp vs 📈 Swing',
          value: [
            `Scalp: ${scalpTrades.length} trades | ${scalpTrades.length > 0 ? (scalpWins.length / scalpTrades.length * 100).toFixed(0) : 0}% WR | $${scalpTrades.reduce((s, t) => s + (t.pnlDollar ?? 0), 0).toFixed(2)}`,
            `Swing/Hybrid: ${swingTrades.length} trades | ${swingTrades.length > 0 ? (swingWins.length / swingTrades.length * 100).toFixed(0) : 0}% WR | $${swingTrades.reduce((s, t) => s + (t.pnlDollar ?? 0), 0).toFixed(2)}`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '💰 Balance Journey',
          value: `Starting: **$${journey.starting.toFixed(2)}** → Peak: **$${journey.peak.toFixed(2)}** → Current: **$${journey.current.toFixed(2)}**`,
          inline: false,
        }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Error: ${String(err)}` });
  }
}
