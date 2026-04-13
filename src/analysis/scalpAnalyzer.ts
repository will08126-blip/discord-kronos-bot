/**
 * Scalp Performance Analyzer — 7-Day Rolling Analysis Engine
 *
 * Runs weekly (every Sunday midnight UTC) on all paper trades from the past 7 days.
 * Computes win-rate correlations across every dimension we log at entry, then
 * feeds the results into the auto-adjuster which updates scalp_params.json.
 *
 * Outputs:
 *   1. A structured JSON report  → data/scalp_report_YYYY-MM-DD.json
 *   2. Human-readable markdown   → data/scalp_report_YYYY-MM-DD.md
 *   3. Auto-adjusted params      → data/scalp_params.json (via scalpParams.ts)
 */

import fs from 'fs';
import path from 'path';
import { loadPaperTrades } from '../paper/paperTrading';
import {
  loadScalpParams,
  saveScalpParams,
  recordAdjustment,
} from '../paper/scalpParams';
import type { ScalpParams } from '../paper/scalpParams';
import type { PaperTrade } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WinLoss { wins: number; losses: number; pnlR: number; pnlDollar: number }

function empty(): WinLoss { return { wins: 0, losses: 0, pnlR: 0, pnlDollar: 0 }; }

function addTrade(acc: WinLoss, t: PaperTrade): void {
  if ((t.pnlDollar ?? 0) > 0) acc.wins++;
  else acc.losses++;
  acc.pnlR += t.pnlR ?? 0;
  acc.pnlDollar += t.pnlDollar ?? 0;
}

function winRate(w: WinLoss): number {
  const total = w.wins + w.losses;
  return total > 0 ? w.wins / total : 0;
}

function profitFactor(w: WinLoss, trades: PaperTrade[]): number {
  const gross = trades.filter((t) => (t.pnlDollar ?? 0) > 0).reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
  const loss  = Math.abs(trades.filter((t) => (t.pnlDollar ?? 0) <= 0).reduce((s, t) => s + (t.pnlDollar ?? 0), 0));
  return loss > 0 ? gross / loss : gross > 0 ? 999 : 0;
}

export interface DimensionBreakdown {
  label: string;
  total: number;
  winRate: number;
  avgR: number;
  pnlDollar: number;
}

export interface ScalpWeeklyReport {
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  totalPnlDollar: number;
  totalPnlR: number;
  avgHoldMinutes: number;

  // Breakdowns — sorted by win rate desc
  byStrategy: DimensionBreakdown[];
  byAsset: DimensionBreakdown[];
  byHour: DimensionBreakdown[];       // grouped by UTC hour
  byDayOfWeek: DimensionBreakdown[];
  byRegime: DimensionBreakdown[];
  byScoreBand: DimensionBreakdown[];  // 35-50, 50-65, 65-80, 80+
  byLeverageBand: DimensionBreakdown[]; // <30x, 30-50x, 50-70x, 70x+
  byTradeType: DimensionBreakdown[];
  byRsiRange: DimensionBreakdown[];   // RSI 5m at entry: <30, 30-45, 45-55, 55-70, >70
  byTrend5m: DimensionBreakdown[];
  byFVGPresence: DimensionBreakdown[];

  // Auto-adjustment decisions
  autoAdjustments: AutoAdjustment[];

  // Recommendations for Claude to implement (structural, requires code change)
  claudeRecommendations: string[];
}

export interface AutoAdjustment {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
}

// ─── Main analysis function ───────────────────────────────────────────────────

export function analyzeWeeklyScalpPerformance(): ScalpWeeklyReport {
  const now = new Date();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const allTrades = loadPaperTrades();
  const trades = allTrades.filter(
    (t) => t.status === 'closed' &&
           t.closeTime !== undefined &&
           new Date(t.closeTime).getTime() >= weekAgo
  );

  const totalWL = empty();
  for (const t of trades) addTrade(totalWL, t);
  const wr = winRate(totalWL);
  const pf = profitFactor(totalWL, trades);
  const avgHold = trades.length > 0
    ? trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length
    : 0;

  // ── Dimension breakdowns ──────────────────────────────────────────────────

  function breakdownBy<K extends string>(
    getKey: (t: PaperTrade) => K | null,
    labelMap?: (k: K) => string,
  ): DimensionBreakdown[] {
    const map = new Map<string, { wl: WinLoss; trades: PaperTrade[] }>();
    for (const t of trades) {
      const k = getKey(t);
      if (k === null) continue;
      const label = labelMap ? labelMap(k) : String(k);
      if (!map.has(label)) map.set(label, { wl: empty(), trades: [] });
      const entry = map.get(label)!;
      addTrade(entry.wl, t);
      entry.trades.push(t);
    }
    return [...map.entries()].map(([label, { wl, trades: ts }]) => ({
      label,
      total: ts.length,
      winRate: winRate(wl),
      avgR: ts.length > 0 ? wl.pnlR / ts.length : 0,
      pnlDollar: wl.pnlDollar,
    })).sort((a, b) => b.winRate - a.winRate);
  }

  const byStrategy    = breakdownBy((t) => t.strategy as string | null);
  const byAsset       = breakdownBy((t) => t.asset.split('/')[0] as string | null);
  const byRegime      = breakdownBy((t) => (t.meta?.regime ?? null) as string | null);
  const byTradeType   = breakdownBy((t) => t.tradeType as string | null);

  const byHour = breakdownBy(
    (t) => t.meta ? String(t.meta.hourUTC) as string : null,
    (k) => `${k.padStart(2, '0')}:00 UTC`,
  );

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDayOfWeek = breakdownBy(
    (t) => t.meta ? String(t.meta.dayOfWeekUTC) as string : null,
    (k) => DAY_NAMES[parseInt(k)] ?? k,
  );

  const byScoreBand = breakdownBy((t): string | null => {
    const s = t.meta?.signalScore;
    if (s === undefined) return null;
    if (s < 50)  return '35–50';
    if (s < 65)  return '50–65';
    if (s < 80)  return '65–80';
    return '80+';
  });

  const byLeverageBand = breakdownBy((t): string | null => {
    const lev = t.leverage;
    if (lev < 30)  return '<30x';
    if (lev < 50)  return '30–50x';
    if (lev < 70)  return '50–70x';
    return '70x+';
  });

  const byRsiRange = breakdownBy((t): string | null => {
    const r = t.meta?.rsi5m;
    if (r === undefined || isNaN(r)) return null;
    if (r < 30)  return 'RSI <30 (oversold)';
    if (r < 45)  return 'RSI 30–45';
    if (r < 55)  return 'RSI 45–55 (neutral)';
    if (r < 70)  return 'RSI 55–70';
    return 'RSI >70 (overbought)';
  });

  const byTrend5m = breakdownBy((t): string | null => t.meta?.trend5m ?? null);

  const byFVGPresence = breakdownBy((t): string | null => {
    if (t.meta === undefined) return null;
    return t.meta.hasFVG ? `FVG present (${t.meta.fvgType})` : 'No FVG';
  });

  // ── Auto-adjustment logic ─────────────────────────────────────────────────
  const adjustments: AutoAdjustment[] = [];
  const params = loadScalpParams();

  if (trades.length >= 10) {
    // Score threshold: raise if WR < 38%, lower if WR > 65%
    if (wr < 0.38 && params.minScoreScalp < 60) {
      const old = params.minScoreScalp;
      const nw  = Math.min(60, old + 5);
      recordAdjustment(params, 'minScoreScalp', old, nw, `7d WR=${(wr*100).toFixed(0)}% < 38% — tightening signal filter`);
      params.minScoreScalp = nw;
      adjustments.push({ field: 'minScoreScalp', oldValue: old, newValue: nw, reason: `WR ${(wr*100).toFixed(0)}% < 38%` });
    } else if (wr > 0.65 && params.minScoreScalp > 30) {
      const old = params.minScoreScalp;
      const nw  = Math.max(30, old - 3);
      recordAdjustment(params, 'minScoreScalp', old, nw, `7d WR=${(wr*100).toFixed(0)}% > 65% — taking more trades`);
      params.minScoreScalp = nw;
      adjustments.push({ field: 'minScoreScalp', oldValue: old, newValue: nw, reason: `WR ${(wr*100).toFixed(0)}% > 65%` });
    }

    // Leverage multiplier: high leverage bands outperforming → can increase
    const highLevBand = byLeverageBand.find((b) => b.label === '70x+');
    const lowLevBand  = byLeverageBand.find((b) => b.label === '<30x');
    if (highLevBand && lowLevBand && highLevBand.total >= 5 && highLevBand.winRate > 0.60 &&
        highLevBand.winRate > (lowLevBand?.winRate ?? 0) && params.leverageMultiplier < 1.2) {
      const old = params.leverageMultiplier;
      const nw  = Math.min(1.2, old + 0.05);
      recordAdjustment(params, 'leverageMultiplier', old, nw, `70x+ band WR=${(highLevBand.winRate*100).toFixed(0)}% outperforming`);
      params.leverageMultiplier = nw;
      adjustments.push({ field: 'leverageMultiplier', oldValue: old, newValue: nw, reason: `High leverage outperforming` });
    }

    // Asset weights: penalise assets with < 35% WR over >= 6 trades
    for (const ab of byAsset) {
      if (ab.total >= 6 && ab.winRate < 0.35) {
        const asset = ab.label + '/USDT'; // reconstruct full pair
        const oldW = params.assetWeights[asset] ?? 1.0;
        const newW = Math.max(0.2, oldW * 0.7);
        params.assetWeights[asset] = newW;
        recordAdjustment(params, `assetWeights.${asset}`, oldW, newW,
          `${ab.label} WR=${(ab.winRate*100).toFixed(0)}% over ${ab.total} trades`);
        adjustments.push({ field: `assetWeights.${asset}`, oldValue: oldW, newValue: newW,
          reason: `${ab.label} WR ${(ab.winRate*100).toFixed(0)}% < 35%` });
      } else if (ab.total >= 6 && ab.winRate > 0.65) {
        // Recovering / boosting good assets
        const asset = ab.label + '/USDT';
        const oldW = params.assetWeights[asset] ?? 1.0;
        const newW = Math.min(1.5, oldW * 1.1);
        if (newW !== oldW) {
          params.assetWeights[asset] = newW;
          recordAdjustment(params, `assetWeights.${asset}`, oldW, newW,
            `${ab.label} WR=${(ab.winRate*100).toFixed(0)}% over ${ab.total} trades`);
          adjustments.push({ field: `assetWeights.${asset}`, oldValue: oldW, newValue: newW,
            reason: `${ab.label} WR ${(ab.winRate*100).toFixed(0)}% > 65%` });
        }
      }
    }

    // Strategy weights: penalise strategies with < 35% WR over >= 5 trades
    for (const sb of byStrategy) {
      if (sb.total >= 5 && sb.winRate < 0.35) {
        const oldW = params.strategyWeights[sb.label] ?? 1.0;
        const newW = Math.max(0.3, oldW * 0.8);
        params.strategyWeights[sb.label] = newW;
        recordAdjustment(params, `strategyWeights.${sb.label}`, oldW, newW,
          `WR=${(sb.winRate*100).toFixed(0)}% over ${sb.total} trades`);
        adjustments.push({ field: `strategyWeights.${sb.label}`, oldValue: oldW, newValue: newW,
          reason: `WR ${(sb.winRate*100).toFixed(0)}% < 35%` });
      } else if (sb.total >= 5 && sb.winRate > 0.65) {
        const oldW = params.strategyWeights[sb.label] ?? 1.0;
        const newW = Math.min(1.5, oldW * 1.1);
        if (newW !== oldW) {
          params.strategyWeights[sb.label] = newW;
          recordAdjustment(params, `strategyWeights.${sb.label}`, oldW, newW,
            `WR=${(sb.winRate*100).toFixed(0)}% over ${sb.total} trades`);
          adjustments.push({ field: `strategyWeights.${sb.label}`, oldValue: oldW, newValue: newW,
            reason: `WR ${(sb.winRate*100).toFixed(0)}% > 65%` });
        }
      }
    }

    // Session filter: if the 3 worst hours have WR < 30% AND the 3 best have WR > 60%,
    // enable session filter and block the worst hours
    const sortedHours = [...byHour].sort((a, b) => b.winRate - a.winRate);
    const bestHours   = sortedHours.slice(0, 3).filter((h) => h.total >= 3 && h.winRate > 0.60);
    const worstHours  = sortedHours.slice(-3).filter((h) => h.total >= 3 && h.winRate < 0.30);
    if (bestHours.length >= 2 && worstHours.length >= 2 && !params.sessionFilterEnabled) {
      const blockedHours = worstHours.map((h) => parseInt(h.label.split(':')[0]));
      params.sessionFilterEnabled = true;
      params.allowedHoursUTC = Array.from({ length: 24 }, (_, i) => i)
        .filter((h) => !blockedHours.includes(h));
      recordAdjustment(params, 'sessionFilterEnabled', false, true, `Enabling session filter — blocking hours ${blockedHours.join(', ')}`);
      adjustments.push({ field: 'sessionFilterEnabled', oldValue: false, newValue: true,
        reason: `Best hours >60% WR, worst hours <30% WR` });
    }

    params.lastAutoAdjust = new Date().toISOString();
    saveScalpParams(params);
  }

  // ── Claude recommendations (structural improvements, require code change) ──
  const recs: string[] = [];

  // RSI filter recommendation
  const overboughtWR  = byRsiRange.find((r) => r.label.includes('>70'));
  const oversoldWR    = byRsiRange.find((r) => r.label.includes('<30'));
  if (overboughtWR && overboughtWR.total >= 4 && overboughtWR.winRate < 0.35) {
    recs.push(`RSI >70 entries have ${(overboughtWR.winRate*100).toFixed(0)}% WR (${overboughtWR.total} trades) — add RSI < 72 entry filter for LONG scalps`);
  }
  if (oversoldWR && oversoldWR.total >= 4 && oversoldWR.winRate < 0.35) {
    recs.push(`RSI <30 entries have ${(oversoldWR.winRate*100).toFixed(0)}% WR (${oversoldWR.total} trades) — add RSI > 28 entry filter for SHORT scalps`);
  }

  // FVG recommendation
  const fvgPresent = byFVGPresence.find((r) => r.label.startsWith('FVG present'));
  const noFVG      = byFVGPresence.find((r) => r.label === 'No FVG');
  if (fvgPresent && noFVG && fvgPresent.total >= 5 && noFVG.total >= 5) {
    if (fvgPresent.winRate > noFVG.winRate + 0.15) {
      recs.push(`FVG-present trades win ${(fvgPresent.winRate*100).toFixed(0)}% vs non-FVG ${(noFVG.winRate*100).toFixed(0)}% — consider requiring FVG for all scalp entries`);
    } else if (noFVG.winRate > fvgPresent.winRate + 0.15) {
      recs.push(`Non-FVG trades outperform FVG trades (${(noFVG.winRate*100).toFixed(0)}% vs ${(fvgPresent.winRate*100).toFixed(0)}%) — FVG filter may be over-constraining`);
    }
  }

  // Trend filter recommendation
  const neutralTrend = byTrend5m.find((r) => r.label === 'NEUTRAL');
  if (neutralTrend && neutralTrend.total >= 5 && neutralTrend.winRate < 0.35) {
    recs.push(`Neutral 5m trend entries have ${(neutralTrend.winRate*100).toFixed(0)}% WR — add stricter trend confirmation requirement (require 5m AND 15m agreement)`);
  }

  // Regime recommendation
  const poorRegime = byRegime.find((r) => r.label === 'RANGE' || r.label === 'LOW_VOL_COMPRESSION');
  if (poorRegime && poorRegime.total >= 5 && poorRegime.winRate < 0.35) {
    recs.push(`${poorRegime.label} regime scalps win only ${(poorRegime.winRate*100).toFixed(0)}% — consider adding ADX > 20 filter or removing ${poorRegime.label} from allowed regimes`);
  }

  // MACD freshness recommendation
  const macdCrossedTrades = trades.filter((t) => t.meta?.macdCrossed5m);
  const macdStaleTrades   = trades.filter((t) => t.meta && !t.meta.macdCrossed5m);
  if (macdCrossedTrades.length >= 5 && macdStaleTrades.length >= 5) {
    const crossedWR = macdCrossedTrades.filter((t) => (t.pnlDollar ?? 0) > 0).length / macdCrossedTrades.length;
    const staleWR   = macdStaleTrades.filter((t)  => (t.pnlDollar ?? 0) > 0).length / macdStaleTrades.length;
    if (crossedWR > staleWR + 0.15) {
      recs.push(`Fresh MACD cross entries win ${(crossedWR*100).toFixed(0)}% vs stale MACD ${(staleWR*100).toFixed(0)}% — tighten crossover freshness window from 3 bars to 1 bar`);
    }
  }

  if (trades.length < 10) {
    recs.push(`Only ${trades.length} trades this week — insufficient data for reliable conclusions. Keep defaults and gather more data before adjusting thresholds.`);
  }

  const report: ScalpWeeklyReport = {
    generatedAt: now.toISOString(),
    periodStart: new Date(weekAgo).toISOString(),
    periodEnd: now.toISOString(),
    totalTrades: trades.length,
    wins: totalWL.wins,
    losses: totalWL.losses,
    winRate: wr,
    profitFactor: pf,
    totalPnlDollar: totalWL.pnlDollar,
    totalPnlR: totalWL.pnlR,
    avgHoldMinutes: avgHold,
    byStrategy,
    byAsset,
    byHour,
    byDayOfWeek,
    byRegime,
    byScoreBand,
    byLeverageBand,
    byTradeType,
    byRsiRange,
    byTrend5m,
    byFVGPresence,
    autoAdjustments: adjustments,
    claudeRecommendations: recs,
  };

  return report;
}

// ─── Save reports ─────────────────────────────────────────────────────────────

export function saveWeeklyReport(report: ScalpWeeklyReport): { jsonPath: string; mdPath: string } {
  const date = new Date(report.generatedAt).toISOString().slice(0, 10);
  const jsonPath = path.join(config.paths.data, `scalp_report_${date}.json`);
  const mdPath   = path.join(config.paths.data, `scalp_report_${date}.md`);

  fs.mkdirSync(config.paths.data, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath,   buildMarkdownReport(report));

  logger.info(`scalpAnalyzer: reports saved → ${jsonPath}`);
  return { jsonPath, mdPath };
}

function buildMarkdownReport(r: ScalpWeeklyReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const dollar = (n: number) => `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
  const lines: string[] = [
    `# Scalp Performance Report — ${r.periodStart.slice(0, 10)} → ${r.periodEnd.slice(0, 10)}`,
    ``,
    `> Generated: ${r.generatedAt}`,
    ``,
    `## Summary`,
    `- **Total trades:** ${r.totalTrades} (W: ${r.wins} / L: ${r.losses})`,
    `- **Win rate:** ${pct(r.winRate)}`,
    `- **Profit factor:** ${r.profitFactor.toFixed(2)}`,
    `- **Total P&L:** ${dollar(r.totalPnlDollar)} (${r.totalPnlR.toFixed(2)}R)`,
    `- **Avg hold time:** ${r.avgHoldMinutes.toFixed(0)} minutes`,
    ``,
    `## By Strategy`,
    ...r.byStrategy.map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR | avg ${b.avgR.toFixed(2)}R | ${dollar(b.pnlDollar)}`
    ),
    ``,
    `## By Asset (top 10)`,
    ...r.byAsset.slice(0, 10).map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR | ${dollar(b.pnlDollar)}`
    ),
    ``,
    `## By Hour (UTC)`,
    ...r.byHour.slice(0, 8).map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR`
    ),
    ``,
    `## By Score Band`,
    ...r.byScoreBand.map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR | avg ${b.avgR.toFixed(2)}R`
    ),
    ``,
    `## By Leverage Band`,
    ...r.byLeverageBand.map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR | avg ${b.avgR.toFixed(2)}R`
    ),
    ``,
    `## By RSI at Entry (5m)`,
    ...r.byRsiRange.map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR`
    ),
    ``,
    `## By 5m Trend`,
    ...r.byTrend5m.map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR`
    ),
    ``,
    `## FVG at Entry`,
    ...r.byFVGPresence.map((b) =>
      `- **${b.label}:** ${b.total} trades | ${pct(b.winRate)} WR`
    ),
    ``,
    `## Auto-Adjustments Applied`,
    r.autoAdjustments.length === 0
      ? '- None (insufficient data or no thresholds breached)'
      : r.autoAdjustments.map((a) =>
          `- **${a.field}:** ${JSON.stringify(a.oldValue)} → ${JSON.stringify(a.newValue)} *(${a.reason})*`
        ).join('\n'),
    ``,
    `## Recommendations for Claude`,
    `*The following are structural improvements requiring code changes:*`,
    ``,
    r.claudeRecommendations.length === 0
      ? '- No actionable recommendations this week.'
      : r.claudeRecommendations.map((rec, i) => `${i + 1}. ${rec}`).join('\n'),
    ``,
    `---`,
    `*Paste this report into your Claude conversation and ask: "Update the bot based on this report."*`,
  ];
  return lines.join('\n');
}

// ─── Load the most recent saved report ───────────────────────────────────────

export function loadLatestReport(): ScalpWeeklyReport | null {
  try {
    const files = fs.readdirSync(config.paths.data)
      .filter((f) => f.startsWith('scalp_report_') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const raw = fs.readFileSync(path.join(config.paths.data, files[0]), 'utf-8');
    return JSON.parse(raw) as ScalpWeeklyReport;
  } catch {
    return null;
  }
}

// ─── Apply auto-adjustments from a report (called after analysis) ────────────

export function applyAutoAdjustments(params: ScalpParams): void {
  saveScalpParams(params);
}
