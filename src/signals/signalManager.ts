import fs from 'fs';
import path from 'path';
import type { StrategySignal, ActivePosition, ClosedTrade, ExitReason, OHLCV } from '../types';
import { calculateRisk } from '../risk/riskCalculator';
import { addTrade } from '../performance/tracker';
import { onTradeClosed } from '../adaptation/adaptation';
import { cachedAtr, cachedEma, cachedRsi } from '../indicators/cache';
import { config } from '../config';
import { logger } from '../utils/logger';

// In-memory stores
const pendingSignals = new Map<string, StrategySignal>();    // posted, awaiting confirmation
const activePositions = new Map<string, ActivePosition>();   // confirmed, being tracked
const recentlySentAssets = new Map<string, number>();        // for duplicate suppression

// ─── Position persistence ──────────────────────────────────────────────────────

const POSITIONS_FILE = path.join(config.paths.data, 'positions.json');

export function savePositions(): void {
  try {
    fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
    const tmp = POSITIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...activePositions.values()], null, 2));
    fs.renameSync(tmp, POSITIONS_FILE);
  } catch (err) {
    logger.error('Failed to save active positions to disk:', err);
  }
}

/** Load positions saved from a previous session. Call once at startup. */
export function loadPositions(): void {
  if (!fs.existsSync(POSITIONS_FILE)) return;
  try {
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
    const data: ActivePosition[] = JSON.parse(raw);
    for (const p of data) activePositions.set(p.id, p);
    logger.info(`Restored ${data.length} active position(s) from disk`);
  } catch (err) {
    logger.warn('Failed to load saved positions — starting fresh:', err);
  }
}

// ─── Signal lifecycle ─────────────────────────────────────────────────────────

export function addPendingSignal(signal: StrategySignal): void {
  pendingSignals.set(signal.id, signal);
  // Expire after 2 hours if not confirmed
  setTimeout(() => pendingSignals.delete(signal.id), 2 * 60 * 60 * 1000);
}

export function getPendingSignal(id: string): StrategySignal | undefined {
  return pendingSignals.get(id);
}

export function getAllPendingSignals(): StrategySignal[] {
  return [...pendingSignals.values()];
}

export function dismissPendingSignal(id: string): boolean {
  return pendingSignals.delete(id);
}

/** User confirmed they entered the trade */
export function confirmEntry(
  signalId: string,
  entryPrice: number,
  messageId: string,
  channelId: string
): ActivePosition | null {
  const signal = pendingSignals.get(signalId);
  if (!signal) return null;

  if (activePositions.size >= config.trading.maxOpenPositions) {
    logger.warn(`Max open positions (${config.trading.maxOpenPositions}) reached — cannot add more`);
    return null;
  }

  const risk = calculateRisk(signal);

  // ── Leverage-adjusted TP ─────────────────────────────────────────────────
  // If TARGET_RETURN_PCT is configured, override the technical TP so the
  // position closes when the user's capital has grown by that fraction.
  // Formula: required price move = targetReturnPct / leverage
  // e.g.  100% return with 25x lev → price must move 4% (100 / 25 = 4%)
  const targetReturn = config.trading.targetReturnPct;
  const isLong = signal.direction === 'LONG';
  let adjustedTP = signal.takeProfit;
  if (targetReturn > 0 && risk.suggestedLeverage > 0) {
    const priceMovePct = targetReturn / risk.suggestedLeverage;
    adjustedTP = isLong
      ? entryPrice * (1 + priceMovePct)
      : entryPrice * (1 - priceMovePct);
    logger.info(
      `TP overridden to leverage target: ${targetReturn * 100}% return @ ${risk.suggestedLeverage}x ` +
      `→ price move ${(priceMovePct * 100).toFixed(2)}% → TP ${adjustedTP.toFixed(4)}`
    );
  }

  const position: ActivePosition = {
    id: signalId,
    signal,
    entryPrice,
    suggestedLeverage: risk.suggestedLeverage,
    riskPct: risk.riskPct,
    confirmedAt: Date.now(),
    messageId,
    channelId,
    currentStopLoss: signal.stopLoss,
    currentTakeProfit: adjustedTP,
    highestPrice: entryPrice,
    lowestPrice: entryPrice,
    lastSLTPUpdateAt: Date.now(),
    tpExtensionCount: 0,
    exitAlertSent: false,
  };

  activePositions.set(signalId, position);
  pendingSignals.delete(signalId);
  savePositions();
  logger.info(`Position confirmed: ${signal.asset} ${signal.direction} @ ${entryPrice}`);
  return position;
}

export function getActivePosition(id: string): ActivePosition | undefined {
  return activePositions.get(id);
}

export function getAllActivePositions(): ActivePosition[] {
  return [...activePositions.values()];
}

/**
 * User manually reports they closed the trade at a given price.
 * This is the primary way trades get closed in this bot.
 */
export function closePositionManually(
  positionId: string,
  exitPrice: number
): ClosedTrade | null {
  return closePosition(positionId, exitPrice, 'MANUAL');
}

function closePosition(
  positionId: string,
  exitPrice: number,
  reason: ExitReason
): ClosedTrade | null {
  const position = activePositions.get(positionId);
  if (!position) return null;

  const isLong = position.signal.direction === 'LONG';
  const pnlPct = isLong
    ? (exitPrice - position.entryPrice) / position.entryPrice
    : (position.entryPrice - exitPrice) / position.entryPrice;

  // P&L expressed as R-multiples (how many R gained/lost) since we have no fixed capital
  // pnlDollar is stored as R-multiple × 100 for display (e.g. 1.5R = 150)
  const stopDist = Math.abs(position.entryPrice - position.signal.stopLoss) / position.entryPrice;
  const rMultiple = stopDist > 0 ? pnlPct / stopDist : 0;
  const pnlDollar = rMultiple; // stored as R-multiple; display layer formats it as "1.5R"

  const trade: ClosedTrade = {
    ...position,
    exitPrice,
    closedAt: Date.now(),
    pnlPct,
    pnlDollar,
    pnlR: rMultiple,
    exitReason: reason,
  };

  activePositions.delete(positionId);
  savePositions();
  addTrade(trade);
  onTradeClosed(trade);

  logger.info(
    `Trade closed: ${position.signal.asset} ${position.signal.direction} ` +
    `${reason} @ ${exitPrice} — P&L ${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(2)}% ($${pnlDollar.toFixed(2)})`
  );

  return trade;
}

// ─── Dynamic SL/TP Trailing ───────────────────────────────────────────────────

/**
 * Called every scan cycle with fresh OHLCV data.
 * Updates trailing stop and adjusts TP upward if momentum continues.
 *
 * Trailing stop rules:
 *   SCALP LONG:  trail 0.8× ATR below recent high
 *   SWING LONG:  trail 1.5× ATR below recent high
 *   SCALP SHORT: trail 0.8× ATR above recent low
 *   SWING SHORT: trail 1.5× ATR above recent low
 *
 * TP extension rule:
 *   If price has moved > 1.5× original stop distance in our favour,
 *   extend TP by 0.5× stop distance.
 *
 * Returns a list of positions where SL/TP changed significantly (> 0.2%),
 * so the caller can send a Discord update.
 */
export interface SLTPUpdate {
  position: ActivePosition;
  oldTP: number;
  newTP: number;
  hitTP: boolean;   // current price crossed TP
  currentPrice: number;
}

export function updateDynamicSLTP(
  position: ActivePosition,
  candles5m: OHLCV[],
  currentPrice: number,
  allowExtension = true
): SLTPUpdate | null {
  const isLong = position.signal.direction === 'LONG';

  const atrVals = cachedAtr(candles5m, 14);
  const currentAtr = atrVals[atrVals.length - 1];
  if (!currentAtr || isNaN(currentAtr)) return null;

  const oldTP = position.currentTakeProfit;

  // Track price extremes (used for TP extension)
  if (isLong && currentPrice > position.highestPrice) position.highestPrice = currentPrice;
  if (!isLong && currentPrice < position.lowestPrice) position.lowestPrice = currentPrice;

  // ── TP extension: milestone-based, capped ────────────────────────────
  // Extend TP once for each whole R-multiple milestone achieved (2R, 3R, 4R...),
  // using 1× ATR per milestone. Max 5 total (shared with momentum extensions via
  // tpExtensionCount). This prevents the old unbounded per-scan creep that caused
  // TPs to drift to unrealistic levels over long-held positions.
  const originalStopDist = Math.abs(position.entryPrice - position.signal.stopLoss);
  const priceMoved = isLong
    ? currentPrice - position.entryPrice
    : position.entryPrice - currentPrice;

  let newTP = oldTP;
  const rAchieved = originalStopDist > 0 ? priceMoved / originalStopDist : 0;
  // Only fire at whole-R milestones starting at 2R; cap at 5 total extensions
  const newMilestone = Math.min(Math.floor(rAchieved), 5);
  const MAX_AUTO_EXTENSIONS = 5;
  if (
    allowExtension &&
    newMilestone >= 2 &&
    newMilestone > position.tpExtensionCount &&
    position.tpExtensionCount < MAX_AUTO_EXTENSIONS
  ) {
    // 1× ATR per milestone so extension scales with current volatility
    const extension = currentAtr;
    const extended = isLong ? oldTP + extension : oldTP - extension;
    if (isLong && extended > newTP) newTP = extended;
    if (!isLong && extended < newTP) newTP = extended;
    position.tpExtensionCount = newMilestone;
  }

  // Commit changes
  position.currentTakeProfit = newTP;
  position.lastSLTPUpdateAt = Date.now();

  // ── Check for TP breach ───────────────────────────────────────────────
  const hitTP = isLong ? currentPrice >= newTP : currentPrice <= newTP;

  // Only report if TP extended meaningfully (> 0.2%) or if hit
  const tpChangePct = Math.abs(newTP - oldTP) / oldTP;
  const significantChange = tpChangePct > 0.002;

  if (!significantChange && !hitTP) return null;

  return {
    position,
    oldTP,
    newTP,
    hitTP,
    currentPrice,
  };
}

/**
 * Automatically close a position when SL or TP is hit.
 * Called by the engine after updateDynamicSLTP.
 */
export function handleSLTPHit(update: SLTPUpdate): ClosedTrade | null {
  if (update.hitTP) {
    return closePosition(update.position.id, update.currentPrice, 'TP');
  }
  return null;
}

// ─── Momentum-based TP extension ──────────────────────────────────────────────

/**
 * Evaluates whether live momentum supports extending TP further.
 * Checks three conditions and returns true if at least 2 pass:
 *
 *   1. Price is on the correct side of EMA(9)      — trend intact
 *   2. RSI(14) is not in extreme territory          — room left to run
 *      (< 80 for LONG, > 20 for SHORT)
 *   3. Both of the last 2 candles closed in the     — recent momentum
 *      trade direction
 */
export function evaluateMomentumForExtension(
  candles: OHLCV[],
  direction: string
): boolean {
  if (candles.length < 15) return false;
  const isLong = direction === 'LONG';

  // 1. EMA(9): is price still on the right side?
  const emaVals = cachedEma(candles, 9);
  const currentEma = emaVals[emaVals.length - 1];
  const currentClose = candles[candles.length - 1].close;
  const emaPass = !isNaN(currentEma) && (isLong ? currentClose > currentEma : currentClose < currentEma);

  // 2. RSI(14): not overbought/oversold at the extreme
  const rsiVals = cachedRsi(candles, 14);
  const currentRsi = rsiVals[rsiVals.length - 1];
  const rsiPass = !isNaN(currentRsi) && (isLong ? currentRsi < 80 : currentRsi > 20);

  // 3. Last 2 candles closed in the trade direction
  const last2 = candles.slice(-2);
  const bullish = last2.filter((c) => c.close > c.open).length;
  const bearish = last2.filter((c) => c.close < c.open).length;
  const candlePass = isLong ? bullish >= 2 : bearish >= 2;

  return [emaPass, rsiPass, candlePass].filter(Boolean).length >= 2;
}

/**
 * Called when price comes within 0.3% of TP.
 * Runs the momentum check and, if it passes and extensions remain,
 * pushes TP out by 1× ATR so the trade can run further.
 *
 * Returns { oldTP, newTP } on success, null if extension was skipped
 * (limit reached, momentum weak, or ATR unavailable).
 *
 * Hard cap: 5 total extensions per position (shared with milestone auto-extensions).
 */
export function attemptMomentumTPExtension(
  position: ActivePosition,
  candles: OHLCV[],
  currentPrice: number
): { oldTP: number; newTP: number } | null {
  if (position.tpExtensionCount >= 5) return null;

  const atrVals = cachedAtr(candles, 14);
  const currentAtr = atrVals[atrVals.length - 1];
  if (!currentAtr || isNaN(currentAtr)) return null;

  if (!evaluateMomentumForExtension(candles, position.signal.direction)) return null;

  const isLong = position.signal.direction === 'LONG';
  const oldTP = position.currentTakeProfit;
  const newTP = isLong ? oldTP + currentAtr : oldTP - currentAtr;

  position.currentTakeProfit = newTP;
  position.tpExtensionCount += 1;
  position.lastSLTPUpdateAt = Date.now();

  logger.info(
    `TP extended by momentum (${position.tpExtensionCount}/5): ` +
    `${position.signal.asset} ${position.signal.direction} ` +
    `TP ${oldTP.toFixed(4)} → ${newTP.toFixed(4)} (ATR=${currentAtr.toFixed(4)})`
  );

  return { oldTP, newTP };
}

// ─── Duplicate suppression ────────────────────────────────────────────────────

export function isDuplicateSignal(signal: StrategySignal): boolean {
  const key = `${signal.asset}:${signal.direction}:${signal.strategy}`;
  const lastSent = recentlySentAssets.get(key);
  const now = Date.now();
  const windowMs = signal.tradeType === 'SWING' 
    ? config.engine.duplicateWindowMsSwing 
    : config.engine.duplicateWindowMs;
  // Prune expired entry on access to prevent unbounded map growth
  if (lastSent !== undefined && now - lastSent >= windowMs) {
    recentlySentAssets.delete(key);
    return false;
  }
  return lastSent !== undefined;
}

export function markSignalSent(signal: StrategySignal): void {
  const key = `${signal.asset}:${signal.direction}:${signal.strategy}`;
  recentlySentAssets.set(key, Date.now());
}
