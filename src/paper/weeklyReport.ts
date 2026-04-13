/**
 * Weekly Scalp Report — Discord Embed Builder
 *
 * Builds the Discord embed posted at the weekly analysis cron.
 * Also attaches the markdown file as a Discord message attachment.
 */

import fs from 'fs';
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import type { TextChannel } from 'discord.js';
import { analyzeWeeklyScalpPerformance, saveWeeklyReport } from '../analysis/scalpAnalyzer';
import type { ScalpWeeklyReport } from '../analysis/scalpAnalyzer';
import { logger } from '../utils/logger';

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function dollar(n: number): string { return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`; }

function buildWeeklyEmbed(r: ScalpWeeklyReport): EmbedBuilder {
  const isProfit  = r.totalPnlDollar >= 0;
  const noTrades  = r.totalTrades === 0;
  const color = noTrades ? 0x5865f2 : isProfit ? 0x00ff87 : 0xff4444;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📊 Weekly Scalp Report — ${r.periodStart.slice(0, 10)} → ${r.periodEnd.slice(0, 10)}`)
    .setTimestamp();

  if (noTrades) {
    embed.setDescription('No paper scalp trades this week — nothing to analyze yet. Keep the bot running!');
    return embed;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  embed.addFields({
    name: '📈 Overview',
    value: [
      `Trades: **${r.totalTrades}** (W: ${r.wins} / L: ${r.losses})`,
      `Win Rate: **${pct(r.winRate)}** | Profit Factor: **${r.profitFactor.toFixed(2)}**`,
      `Total P&L: **${dollar(r.totalPnlDollar)}** (${r.totalPnlR.toFixed(2)}R)`,
      `Avg Hold: **${r.avgHoldMinutes.toFixed(0)}min**`,
    ].join('\n'),
    inline: false,
  });

  // ── Top/bottom 3 assets ────────────────────────────────────────────────────
  const sortedAssets = [...r.byAsset].sort((a, b) => b.pnlDollar - a.pnlDollar);
  const best3  = sortedAssets.slice(0, 3);
  const worst3 = sortedAssets.slice(-3).reverse();
  if (best3.length > 0) {
    embed.addFields({
      name: '🏆 Best Assets',
      value: best3.map((a) => `**${a.label}:** ${pct(a.winRate)} WR | ${dollar(a.pnlDollar)} (${a.total} trades)`).join('\n'),
      inline: true,
    });
  }
  if (worst3.length > 0) {
    embed.addFields({
      name: '💀 Worst Assets',
      value: worst3.map((a) => `**${a.label}:** ${pct(a.winRate)} WR | ${dollar(a.pnlDollar)} (${a.total} trades)`).join('\n'),
      inline: true,
    });
  }

  // ── Strategy breakdown ─────────────────────────────────────────────────────
  if (r.byStrategy.length > 0) {
    embed.addFields({
      name: '🎯 By Strategy',
      value: r.byStrategy.slice(0, 5).map((s) =>
        `**${s.label}:** ${s.total} trades | ${pct(s.winRate)} WR | avg ${s.avgR.toFixed(2)}R`
      ).join('\n'),
      inline: false,
    });
  }

  // ── Best / worst hours ─────────────────────────────────────────────────────
  const topHours  = [...r.byHour].filter((h) => h.total >= 2).sort((a, b) => b.winRate - a.winRate).slice(0, 3);
  const poorHours = [...r.byHour].filter((h) => h.total >= 2).sort((a, b) => a.winRate - b.winRate).slice(0, 3);
  if (topHours.length > 0) {
    embed.addFields({
      name: '⏰ Best Trading Hours (UTC)',
      value: topHours.map((h) => `**${h.label}:** ${pct(h.winRate)} WR (${h.total} trades)`).join('\n'),
      inline: true,
    });
    embed.addFields({
      name: '⚠️ Worst Hours',
      value: poorHours.map((h) => `**${h.label}:** ${pct(h.winRate)} WR (${h.total} trades)`).join('\n'),
      inline: true,
    });
  }

  // ── Score band ─────────────────────────────────────────────────────────────
  if (r.byScoreBand.length > 0) {
    embed.addFields({
      name: '📐 By Score Band',
      value: r.byScoreBand.map((b) => `**${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR | avg ${b.avgR.toFixed(2)}R`).join('\n'),
      inline: false,
    });
  }

  // ── Auto-adjustments ───────────────────────────────────────────────────────
  if (r.autoAdjustments.length > 0) {
    embed.addFields({
      name: '🔧 Auto-Adjustments Applied',
      value: r.autoAdjustments.slice(0, 5).map((a) =>
        `• **${a.field}**: ${JSON.stringify(a.oldValue)} → ${JSON.stringify(a.newValue)}`
      ).join('\n'),
      inline: false,
    });
  } else {
    embed.addFields({
      name: '🔧 Auto-Adjustments',
      value: r.totalTrades < 10
        ? `⚠️ Only ${r.totalTrades} trades — need ≥10 for auto-adjustments. Keeping defaults.`
        : '✅ No threshold breaches — parameters unchanged.',
      inline: false,
    });
  }

  // ── Claude recommendations ─────────────────────────────────────────────────
  if (r.claudeRecommendations.length > 0) {
    const recText = r.claudeRecommendations.slice(0, 3).map((rec, i) => `${i + 1}. ${rec}`).join('\n');
    const truncated = recText.length > 900 ? recText.slice(0, 897) + '…' : recText;
    embed.addFields({
      name: '🤖 Suggestions for Claude',
      value: truncated,
      inline: false,
    });
  }

  embed.setFooter({ text: 'Full report attached as .md file — paste to Claude for code improvements' });
  return embed;
}

/**
 * Run the weekly analysis and post the Discord report.
 * Called from the Sunday midnight cron in engine.ts.
 */
export async function postWeeklyScalpReport(channel: TextChannel): Promise<void> {
  try {
    logger.info('weeklyReport: running weekly scalp analysis...');
    const report = analyzeWeeklyScalpPerformance();
    const { mdPath } = saveWeeklyReport(report);

    const embed = buildWeeklyEmbed(report);

    // Send embed + markdown file attachment
    if (fs.existsSync(mdPath)) {
      const attachment = new AttachmentBuilder(mdPath, { name: `scalp_report_${new Date().toISOString().slice(0, 10)}.md` });
      await channel.send({ embeds: [embed], files: [attachment] });
    } else {
      await channel.send({ embeds: [embed] });
    }

    logger.info(
      `weeklyReport: posted — ${report.totalTrades} trades, ` +
      `WR=${(report.winRate * 100).toFixed(1)}%, ` +
      `PnL=${dollar(report.totalPnlDollar)}, ` +
      `${report.autoAdjustments.length} auto-adjustments`
    );
  } catch (err) {
    logger.error('weeklyReport: failed to post:', err);
  }
}
