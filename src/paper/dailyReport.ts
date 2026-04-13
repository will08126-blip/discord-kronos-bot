/**
 * Daily Paper Trading Report
 *
 * Covers one "trading day" = 00:00 UTC to 23:59 UTC.
 * This maps to approximately 8:00 PM EDT (prev day) → 7:59 PM EDT (current day).
 *
 * The report is formatted as a plain-text markdown document designed to be
 * pasted directly into Claude for analysis and bot improvement suggestions.
 *
 * Also produces a compact Discord embed for the #paper-trading channel.
 */

import fs from 'fs';
import path from 'path';
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import type { TextChannel } from 'discord.js';
import { loadPaperTrades, loadPaperState } from './paperTrading';
import type { PaperTrade } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sign(n: number): string { return n >= 0 ? '+' : ''; }
function pct(n: number): string  { return `${sign(n)}${(n * 100).toFixed(1)}%`; }
function dollar(n: number): string { return `${sign(n)}$${Math.abs(n).toFixed(2)}`; }
function r(n: number): string { return `${sign(n)}${n.toFixed(2)}R`; }

/** Returns YYYY-MM-DD for a given UTC date offset (0 = today, -1 = yesterday). */
function utcDate(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Trades closed within a specific UTC calendar date. */
function tradesForDate(date: string): PaperTrade[] {
  return loadPaperTrades().filter(
    (t) => t.status === 'closed' && (t.closeTime ?? '').slice(0, 10) === date
  );
}

interface DayStats {
  date: string;
  trades: PaperTrade[];
  wins: PaperTrade[];
  losses: PaperTrade[];
  netPnl: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  avgHoldMin: number;
  bestTrade: PaperTrade | null;
  worstTrade: PaperTrade | null;
  balanceStart: number;
  balanceEnd: number;
  openPositions: PaperTrade[];
}

function computeDayStats(date: string): DayStats {
  const trades    = tradesForDate(date);
  const wins      = trades.filter((t) => (t.pnlDollar ?? 0) > 0);
  const losses    = trades.filter((t) => (t.pnlDollar ?? 0) <= 0);
  const netPnl    = trades.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
  const grossWin  = wins.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnlDollar ?? 0), 0));
  const pf        = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const avgR      = trades.length > 0
    ? trades.reduce((s, t) => s + (t.pnlR ?? 0), 0) / trades.length
    : 0;
  const avgHold   = trades.length > 0
    ? trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length
    : 0;

  const state = loadPaperState();
  const allClosed = loadPaperTrades().filter((t) => t.status === 'closed');
  // Balance at start of day = current balance minus today's closed P&L
  const balanceEnd   = state.virtualBalance;
  const balanceStart = balanceEnd - netPnl;

  const open = loadPaperTrades().filter((t) => t.status === 'active');

  return {
    date,
    trades,
    wins,
    losses,
    netPnl,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    profitFactor: pf,
    avgR,
    avgHoldMin: avgHold,
    bestTrade:  trades.length > 0 ? trades.reduce((b, t) => (t.pnlDollar ?? 0) > (b.pnlDollar ?? 0) ? t : b) : null,
    worstTrade: trades.length > 0 ? trades.reduce((w, t) => (t.pnlDollar ?? 0) < (w.pnlDollar ?? 0) ? t : w) : null,
    balanceStart,
    balanceEnd,
    openPositions: open,
  };
}

// ─── Markdown report ──────────────────────────────────────────────────────────

export function buildDailyMarkdownReport(date?: string): string {
  const d     = date ?? utcDate(0);
  const stats = computeDayStats(d);
  const { trades, wins, losses } = stats;

  // Build lookup maps once — reused by strategy, asset, and observation sections
  const stratMap: Record<string, PaperTrade[]> = {};
  const assetMap: Record<string, PaperTrade[]> = {};
  for (const t of trades) {
    (stratMap[t.strategy] ??= []).push(t);
    const base = t.asset.split('/')[0];
    (assetMap[base] ??= []).push(t);
  }

  const lines: string[] = [];
  const hr = '─'.repeat(52);

  lines.push(`# 📊 PAPER TRADING DAILY REPORT`);
  lines.push(``);
  lines.push(`**Period:** ${d} 00:00 UTC → ${d} 23:59 UTC`);
  lines.push(`**EDT equivalent:** ~8:00 PM (prev day) → 7:59 PM (today)`);
  lines.push(`**Generated:** ${new Date().toUTCString()}`);
  lines.push(``);

  // ── Account
  lines.push(`## ACCOUNT`);
  lines.push(hr);
  lines.push(`Balance (end of day) : $${stats.balanceEnd.toFixed(2)}`);
  lines.push(`Balance (start of day): $${stats.balanceStart.toFixed(2)}`);
  lines.push(`Day P&L              : ${dollar(stats.netPnl)} (${pct(stats.balanceStart > 0 ? stats.netPnl / stats.balanceStart : 0)})`);
  lines.push(`All-time P&L         : ${dollar(stats.balanceEnd - config.paper.startingBalance)} (${pct(config.paper.startingBalance > 0 ? (stats.balanceEnd - config.paper.startingBalance) / config.paper.startingBalance : 0)})`);
  lines.push(``);

  // ── Trade Summary
  lines.push(`## TRADE SUMMARY — ${trades.length} closed`);
  lines.push(hr);
  if (trades.length === 0) {
    lines.push(`No trades closed today.`);
  } else {
    lines.push(`Wins        : ${wins.length}  (${(stats.winRate * 100).toFixed(1)}%)`);
    lines.push(`Losses      : ${losses.length}  (${((1 - stats.winRate) * 100).toFixed(1)}%)`);
    lines.push(`Net P&L     : ${dollar(stats.netPnl)}`);
    lines.push(`Profit factor: ${stats.profitFactor.toFixed(2)}`);
    lines.push(`Average R   : ${r(stats.avgR)}`);
    lines.push(`Avg hold    : ${stats.avgHoldMin.toFixed(0)} min`);
    lines.push(`Best trade  : ${stats.bestTrade ? `${stats.bestTrade.asset.split('/')[0]} ${stats.bestTrade.direction} ${dollar(stats.bestTrade.pnlDollar ?? 0)} (${r(stats.bestTrade.pnlR ?? 0)})` : 'N/A'}`);
    lines.push(`Worst trade : ${stats.worstTrade ? `${stats.worstTrade.asset.split('/')[0]} ${stats.worstTrade.direction} ${dollar(stats.worstTrade.pnlDollar ?? 0)} (${r(stats.worstTrade.pnlR ?? 0)})` : 'N/A'}`);
  }
  lines.push(``);

  // ── Strategy Breakdown
  lines.push(`## STRATEGY BREAKDOWN`);
  lines.push(hr);
  if (Object.keys(stratMap).length === 0) {
    lines.push(`No data.`);
  } else {
    lines.push(`${'Strategy'.padEnd(22)} ${'T'.padStart(3)} ${'W'.padStart(3)} ${'L'.padStart(3)} ${'WR'.padStart(6)} ${'P&L'.padStart(9)} ${'AvgR'.padStart(7)}`);
    lines.push(`${'─'.repeat(22)} ${'─'.repeat(3)} ${'─'.repeat(3)} ${'─'.repeat(3)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(7)}`);
    for (const [strat, ts] of Object.entries(stratMap).sort((a, b) => b[1].reduce((s, t) => s + (t.pnlDollar ?? 0), 0) - a[1].reduce((s, t) => s + (t.pnlDollar ?? 0), 0))) {
      const sw   = ts.filter((t) => (t.pnlDollar ?? 0) > 0);
      const sl   = ts.filter((t) => (t.pnlDollar ?? 0) <= 0);
      const spnl = ts.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
      const sAvgR = ts.reduce((s, t) => s + (t.pnlR ?? 0), 0) / ts.length;
      const wr   = ts.length > 0 ? `${((sw.length / ts.length) * 100).toFixed(0)}%` : '—';
      lines.push(`${strat.padEnd(22)} ${String(ts.length).padStart(3)} ${String(sw.length).padStart(3)} ${String(sl.length).padStart(3)} ${wr.padStart(6)} ${dollar(spnl).padStart(9)} ${r(sAvgR).padStart(7)}`);
    }
  }
  lines.push(``);

  // ── Asset Breakdown
  lines.push(`## ASSET BREAKDOWN`);
  lines.push(hr);
  if (Object.keys(assetMap).length === 0) {
    lines.push(`No data.`);
  } else {
    lines.push(`${'Asset'.padEnd(8)} ${'T'.padStart(3)} ${'WR'.padStart(6)} ${'P&L'.padStart(9)} ${'AvgR'.padStart(7)}`);
    lines.push(`${'─'.repeat(8)} ${'─'.repeat(3)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(7)}`);
    for (const [asset, ts] of Object.entries(assetMap).sort((a, b) => b[1].reduce((s, t) => s + (t.pnlDollar ?? 0), 0) - a[1].reduce((s, t) => s + (t.pnlDollar ?? 0), 0))) {
      const aw   = ts.filter((t) => (t.pnlDollar ?? 0) > 0);
      const apnl = ts.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
      const aAvgR = ts.reduce((s, t) => s + (t.pnlR ?? 0), 0) / ts.length;
      const wr   = ts.length > 0 ? `${((aw.length / ts.length) * 100).toFixed(0)}%` : '—';
      lines.push(`${asset.padEnd(8)} ${String(ts.length).padStart(3)} ${wr.padStart(6)} ${dollar(apnl).padStart(9)} ${r(aAvgR).padStart(7)}`);
    }
  }
  lines.push(``);

  // ── Hourly Activity
  lines.push(`## HOURLY ACTIVITY (UTC)`);
  lines.push(hr);
  const hourMap: Record<number, { w: number; l: number }> = {};
  for (const t of trades) {
    const h = new Date(t.closeTime ?? '').getUTCHours();
    if (!hourMap[h]) hourMap[h] = { w: 0, l: 0 };
    if ((t.pnlDollar ?? 0) > 0) hourMap[h].w++; else hourMap[h].l++;
  }
  const activeHours = Object.keys(hourMap).map(Number).sort((a, b) => a - b);
  if (activeHours.length === 0) {
    lines.push(`No data.`);
  } else {
    for (const h of activeHours) {
      const { w, l } = hourMap[h];
      const total = w + l;
      const bar   = '█'.repeat(Math.min(total, 10));
      const wr    = total > 0 ? `${((w / total) * 100).toFixed(0)}%` : '—';
      lines.push(`${String(h).padStart(2, '0')}:00  ${bar.padEnd(10)} ${String(total).padStart(2)}T  ${String(w).padStart(2)}W ${String(l).padStart(2)}L  ${wr}`);
    }
    const bestHour  = activeHours.reduce((b, h) => (hourMap[h].w / Math.max(hourMap[h].w + hourMap[h].l, 1)) > (hourMap[b].w / Math.max(hourMap[b].w + hourMap[b].l, 1)) ? h : b, activeHours[0]);
    const worstHour = activeHours.reduce((w, h) => (hourMap[h].w / Math.max(hourMap[h].w + hourMap[h].l, 1)) < (hourMap[w].w / Math.max(hourMap[w].w + hourMap[w].l, 1)) ? h : w, activeHours[0]);
    lines.push(`Best hour : ${String(bestHour).padStart(2, '0')}:00 UTC (${hourMap[bestHour].w}W/${hourMap[bestHour].l}L)`);
    lines.push(`Worst hour: ${String(worstHour).padStart(2, '0')}:00 UTC (${hourMap[worstHour].w}W/${hourMap[worstHour].l}L)`);
  }
  lines.push(``);

  // ── Top 5 Wins
  lines.push(`## TOP WINS`);
  lines.push(hr);
  const topWins = [...trades].filter((t) => (t.pnlDollar ?? 0) > 0).sort((a, b) => (b.pnlDollar ?? 0) - (a.pnlDollar ?? 0)).slice(0, 5);
  if (topWins.length === 0) {
    lines.push(`No winning trades today.`);
  } else {
    topWins.forEach((t, i) => {
      const asset = t.asset.split('/')[0];
      const held  = `${t.holdMinutes ?? '?'}min`;
      const sc    = t.meta?.signalScore ?? '?';
      lines.push(`${i + 1}. ${asset} ${t.direction}  ${dollar(t.pnlDollar ?? 0)} (${r(t.pnlR ?? 0)})  held=${held}  score=${sc}  reason=${t.closeReason}`);
    });
  }
  lines.push(``);

  // ── Top 5 Losses
  lines.push(`## TOP LOSSES`);
  lines.push(hr);
  const topLosses = [...trades].filter((t) => (t.pnlDollar ?? 0) < 0).sort((a, b) => (a.pnlDollar ?? 0) - (b.pnlDollar ?? 0)).slice(0, 5);
  if (topLosses.length === 0) {
    lines.push(`No losing trades today.`);
  } else {
    topLosses.forEach((t, i) => {
      const asset = t.asset.split('/')[0];
      const held  = `${t.holdMinutes ?? '?'}min`;
      const sc    = t.meta?.signalScore ?? '?';
      lines.push(`${i + 1}. ${asset} ${t.direction}  ${dollar(t.pnlDollar ?? 0)} (${r(t.pnlR ?? 0)})  held=${held}  score=${sc}  reason=${t.closeReason}`);
    });
  }
  lines.push(``);

  // ── Open positions
  lines.push(`## OPEN POSITIONS (${stats.openPositions.length})`);
  lines.push(hr);
  if (stats.openPositions.length === 0) {
    lines.push(`None.`);
  } else {
    for (const t of stats.openPositions) {
      const asset  = t.asset.split('/')[0];
      const dir    = t.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      const entry  = t.entryPrice.toFixed(4);
      const sl     = t.stopLoss.toFixed(4);
      const tp     = t.takeProfit.toFixed(4);
      const cur    = (t.currentPrice ?? t.entryPrice).toFixed(4);
      const unreal = t.currentPrice
        ? ((t.direction === 'LONG'
            ? (t.currentPrice - t.entryPrice)
            : (t.entryPrice - t.currentPrice)) / t.entryPrice * 100).toFixed(2)
        : '0.00';
      lines.push(`${dir} ${asset}  entry=${entry}  cur=${cur}  SL=${sl}  TP=${tp}  unreal=${unreal}%  lev=${t.leverage}x`);
    }
  }
  lines.push(``);

  // ── Pattern observations (auto-generated for Claude context)
  lines.push(`## OBSERVATIONS & PATTERNS FOR CLAUDE`);
  lines.push(hr);
  const obs: string[] = [];

  if (trades.length === 0) {
    obs.push(`• No trades closed today — bot may be too selective or market was inactive.`);
  } else {
    // Win rate assessment
    const wrPct = (stats.winRate * 100).toFixed(1);
    const wrTarget = stats.winRate >= 0.55 ? '✓ above 55% target' : '✗ below 55% target';
    obs.push(`• Win rate: ${wrPct}% — ${wrTarget}`);

    // Profit factor
    obs.push(`• Profit factor: ${stats.profitFactor.toFixed(2)} — ${stats.profitFactor >= 1.5 ? 'healthy' : stats.profitFactor >= 1.0 ? 'breakeven territory' : 'losing day — factor < 1.0'}`);

    // Score comparison wins vs losses
    const winScores  = wins.filter((t) => t.meta?.signalScore).map((t) => t.meta!.signalScore);
    const lossScores = losses.filter((t) => t.meta?.signalScore).map((t) => t.meta!.signalScore);
    if (winScores.length > 0 && lossScores.length > 0) {
      const avgWinScore  = winScores.reduce((s, v) => s + v, 0) / winScores.length;
      const avgLossScore = lossScores.reduce((s, v) => s + v, 0) / lossScores.length;
      obs.push(`• Avg score — wins: ${avgWinScore.toFixed(1)}  losses: ${avgLossScore.toFixed(1)} — ${avgWinScore > avgLossScore + 5 ? 'score discriminates well, consider raising threshold' : 'score not strongly predictive today'}`);
    }

    // Hold time wins vs losses
    const avgWinHold  = wins.length > 0  ? wins.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / wins.length  : 0;
    const avgLossHold = losses.length > 0 ? losses.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / losses.length : 0;
    if (wins.length > 0 && losses.length > 0) {
      obs.push(`• Avg hold — wins: ${avgWinHold.toFixed(0)}min  losses: ${avgLossHold.toFixed(0)}min — ${avgWinHold > avgLossHold ? 'winners held longer (good)' : 'losers held longer — possible early exit on winners'}`);
    }

    // SL vs TP hit ratio
    const slHits = trades.filter((t) => t.closeReason === 'SL hit').length;
    const tpHits = trades.filter((t) => t.closeReason === 'TP hit').length;
    obs.push(`• TP hits: ${tpHits}  SL hits: ${slHits} — ${tpHits > slHits ? 'more TPs than SLs (good RR)' : 'more SLs than TPs — consider tightening entries or widening TP'}`);

    // Underperforming assets
    const badAssets = Object.entries(assetMap ?? {})
      .filter(([, ts]) => ts.filter((t) => (t.pnlDollar ?? 0) > 0).length / ts.length < 0.4 && ts.length >= 3)
      .map(([a]) => a);
    if (badAssets.length > 0) {
      obs.push(`• Underperforming assets today (<40% WR with ≥3 trades): ${badAssets.join(', ')} — consider reducing weights`);
    }

    // Best strategy
    const bestStrat = Object.entries(stratMap ?? {})
      .sort((a, b) => b[1].reduce((s, t) => s + (t.pnlDollar ?? 0), 0) - a[1].reduce((s, t) => s + (t.pnlDollar ?? 0), 0))[0];
    if (bestStrat) {
      obs.push(`• Best strategy today: ${bestStrat[0]} (${dollar(bestStrat[1].reduce((s, t) => s + (t.pnlDollar ?? 0), 0))})`);
    }
  }

  // Reference to full param file
  obs.push(`• Current scalp params: minScoreScalp=${52}, dedupWindow=20min, maxConcurrent=4`);
  obs.push(`• Ask Claude: "Based on this report, what specific changes should I make to improve win rate and P&L?"`);

  for (const o of obs) lines.push(o);
  lines.push(``);
  lines.push(`---`);
  lines.push(`*Paste this entire report into Claude and ask for improvement suggestions.*`);

  return lines.join('\n');
}

// ─── File saving ──────────────────────────────────────────────────────────────

export function saveDailyReport(content: string, date: string): string {
  const dir  = config.paths.data;
  const file = path.join(dir, `daily_report_${date}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    logger.info(`Daily report saved: ${file}`);
  } catch (err) {
    logger.warn(`Could not save daily report: ${err}`);
  }
  return file;
}

// ─── Discord posting ──────────────────────────────────────────────────────────

export async function postDailyPaperReport(channel: TextChannel, date?: string): Promise<void> {
  const d       = date ?? utcDate(0);
  const stats   = computeDayStats(d);
  const content = buildDailyMarkdownReport(d);
  const file    = saveDailyReport(content, d);

  const isProfit = stats.netPnl >= 0;
  const embed = new EmbedBuilder()
    .setColor(stats.trades.length === 0 ? 0x5865f2 : isProfit ? 0x00ff87 : 0xff4444)
    .setTitle(`📊 Paper Trading Daily Report — ${d}`)
    .addFields(
      {
        name: '💰 Account',
        value: [
          `Balance: **$${stats.balanceEnd.toFixed(2)}**`,
          `Day P&L: **${dollar(stats.netPnl)}**`,
          `All-time: ${dollar(stats.balanceEnd - config.paper.startingBalance)}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📈 Today',
        value: stats.trades.length === 0
          ? 'No trades closed.'
          : [
              `${stats.trades.length} trades  ${(stats.winRate * 100).toFixed(0)}% WR`,
              `PF: ${stats.profitFactor.toFixed(2)}  Avg: ${r(stats.avgR)}`,
              `Best: ${stats.bestTrade?.asset.split('/')[0] ?? '—'} ${dollar(stats.bestTrade?.pnlDollar ?? 0)}`,
            ].join('\n'),
        inline: true,
      },
      {
        name: '📂 Open',
        value: stats.openPositions.length === 0
          ? 'None.'
          : stats.openPositions.slice(0, 5).map((t) => {
              const dir = t.direction === 'LONG' ? '🟢' : '🔴';
              return `${dir} ${t.asset.split('/')[0]} ${t.leverage}x`;
            }).join('\n'),
        inline: true,
      }
    )
    .setDescription('Full markdown report attached below — paste into Claude for improvement analysis.')
    .setTimestamp()
    .setFooter({ text: 'Period: 00:00–23:59 UTC ≈ 8 PM–7:59 PM EDT · /daily-report to generate on demand' });

  const attachment = new AttachmentBuilder(Buffer.from(content, 'utf-8'), {
    name: `paper_report_${d}.md`,
    description: 'Daily paper trading report — paste into Claude for analysis',
  });

  await channel.send({ embeds: [embed], files: [attachment] });
  logger.info(`Daily paper report posted for ${d}: ${stats.trades.length} trades, WR=${(stats.winRate * 100).toFixed(0)}%`);
}
