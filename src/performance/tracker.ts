import fs from 'fs';
import path from 'path';
import type {
  ClosedTrade,
  PerformanceStats,
  StrategyStats,
  ActivePosition,
} from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Persistence ─────────────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(config.paths.data)) {
    fs.mkdirSync(config.paths.data, { recursive: true });
  }
}

export function loadTrades(): ClosedTrade[] {
  ensureDataDir();
  if (!fs.existsSync(config.paths.tradesFile)) return [];
  try {
    const raw = fs.readFileSync(config.paths.tradesFile, 'utf-8');
    return JSON.parse(raw) as ClosedTrade[];
  } catch {
    logger.warn('Could not load trades.json, starting fresh');
    return [];
  }
}

export function saveTrades(trades: ClosedTrade[]): void {
  ensureDataDir();
  const tmp = config.paths.tradesFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, config.paths.tradesFile);
}

export function addTrade(trade: ClosedTrade): void {
  const trades = loadTrades();
  trades.push(trade);
  saveTrades(trades);
  logger.info(
    `Trade closed: ${trade.signal.asset} ${trade.signal.direction} ` +
    `${trade.exitReason} P&L=$${trade.pnlDollar >= 0 ? '+' : ''}${trade.pnlDollar.toFixed(2)} (${trade.pnlR >= 0 ? '+' : ''}${trade.pnlR.toFixed(2)}R) ` +
    `(${(trade.pnlPct * 100).toFixed(2)}%)`
  );
}

// ─── Stats computation ────────────────────────────────────────────────────────

export function computeStats(trades: ClosedTrade[]): PerformanceStats {
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);

  const grossProfit = wins.reduce((s, t) => s + t.pnlDollar, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlDollar, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const avgScore =
    trades.length > 0
      ? trades.reduce((s, t) => s + t.signal.score, 0) / trades.length
      : 0;

  // Per-strategy stats
  const byStrategy: Record<string, StrategyStats> = {};
  for (const t of trades) {
    const s = t.signal.strategy;
    if (!byStrategy[s]) {
      byStrategy[s] = { totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgScore: 0 };
    }
    byStrategy[s].totalTrades++;
    if (t.pnlPct > 0) byStrategy[s].wins++;
    else byStrategy[s].losses++;
    byStrategy[s].avgScore += t.signal.score;
  }
  for (const s of Object.keys(byStrategy)) {
    const st = byStrategy[s];
    st.winRate = st.totalTrades > 0 ? st.wins / st.totalTrades : 0;
    st.avgScore = st.totalTrades > 0 ? st.avgScore / st.totalTrades : 0;
  }

  // Per trade-type stats
  const byTradeType: Record<string, { trades: number; wins: number; winRate: number }> = {
    SCALP:  { trades: 0, wins: 0, winRate: 0 },
    HYBRID: { trades: 0, wins: 0, winRate: 0 },
    SWING:  { trades: 0, wins: 0, winRate: 0 },
  };
  for (const t of trades) {
    const tt = t.signal.tradeType ?? 'HYBRID';
    byTradeType[tt].trades++;
    if (t.pnlPct > 0) byTradeType[tt].wins++;
  }
  for (const tt of Object.keys(byTradeType)) {
    const b = byTradeType[tt];
    b.winRate = b.trades > 0 ? b.wins / b.trades : 0;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgScore,
    profitFactor,
    totalPnlDollar: grossProfit - grossLoss,
    byStrategy,
    byTradeType,
  };
}

/** Returns the win rate for a specific strategy over the last N trades */
export function strategyWinRate(strategyName: string, lastN = 10): number {
  const trades = loadTrades();
  const stratTrades = trades
    .filter((t) => t.signal.strategy === strategyName)
    .slice(-lastN);
  if (stratTrades.length === 0) return 0.5; // neutral default
  const wins = stratTrades.filter((t) => t.pnlPct > 0).length;
  return wins / stratTrades.length;
}

/** P&L for current calendar day (UTC) in dollars */
export function dailyPnl(): number {
  const today = new Date().toISOString().slice(0, 10);
  const trades = loadTrades();
  return trades
    .filter((t) => new Date(t.closedAt).toISOString().slice(0, 10) === today)
    .reduce((s, t) => s + t.pnlDollar, 0);
}

/**
 * Build a human-readable daily summary string for LLM consumption
 */
export function buildDailySummaryContext(): string {
  const today = new Date().toISOString().slice(0, 10);
  const trades = loadTrades();
  const todayTrades = trades.filter(
    (t) => new Date(t.closedAt).toISOString().slice(0, 10) === today
  );
  const stats = computeStats(todayTrades);

  const lines = [
    `Date: ${today}`,
    `Total trades: ${stats.totalTrades}`,
    `Wins: ${stats.wins} | Losses: ${stats.losses} | Win rate: ${(stats.winRate * 100).toFixed(1)}%`,
    `Total R: ${stats.totalPnlDollar >= 0 ? '+' : ''}${stats.totalPnlDollar.toFixed(2)}R`,
    `Profit factor: ${stats.profitFactor.toFixed(2)}`,
    `Average setup score: ${stats.avgScore.toFixed(1)}`,
    '',
    'Trades:',
    ...todayTrades.map((t) =>
      `  ${t.signal.asset} ${t.signal.direction} (${t.signal.strategy}) ` +
      `Score=${t.signal.score} Entry=${t.entryPrice.toFixed(2)} Exit=${t.exitPrice.toFixed(2)} ` +
      `Result=${t.pnlDollar >= 0 ? '+' : ''}${t.pnlDollar.toFixed(2)}R (${(t.pnlPct * 100).toFixed(2)}%) Reason=${t.exitReason}`
    ),
  ];
  return lines.join('\n');
}

export function buildWeeklySummaryContext(): string {
  const trades = loadTrades();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekTrades = trades.filter((t) => t.closedAt >= weekAgo);
  const stats = computeStats(weekTrades);

  const lines = [
    `Weekly summary (last 7 days)`,
    `Total trades: ${stats.totalTrades}`,
    `Wins: ${stats.wins} | Losses: ${stats.losses} | Win rate: ${(stats.winRate * 100).toFixed(1)}%`,
    `Total R: ${stats.totalPnlDollar >= 0 ? '+' : ''}${stats.totalPnlDollar.toFixed(2)}R`,
    `Profit factor: ${stats.profitFactor.toFixed(2)}`,
    '',
    'Strategy breakdown:',
    ...Object.entries(stats.byStrategy).map(
      ([name, s]) =>
        `  ${name}: ${s.totalTrades} trades, ${(s.winRate * 100).toFixed(1)}% WR, avg score ${s.avgScore.toFixed(1)}`
    ),
  ];
  return lines.join('\n');
}
