/**
 * Market Structure Analysis
 *
 * Detects Higher Highs / Higher Lows (BULLISH) or Lower Highs / Lower Lows (BEARISH)
 * on Weekly, Daily, and 4h timeframes using pure price structure.
 *
 * Confidence:
 *   HIGH   — all 3 timeframes agree
 *   MEDIUM — Daily + 4h agree (Weekly neutral/insufficient)
 *   LOW    — fewer than 2 agree → no swing signal fires
 */

import { swingPoints } from '../indicators/indicators';
import type { OHLCV, SwingBias, StructuralBias } from '../types';

const SWING_CONFIG = {
  '1w': { left: 2, right: 2, min: 10 },
  '1d': { left: 3, right: 3, min: 14 },
  '4h': { left: 4, right: 4, min: 20 },
} as const;

const CONFIRMATION_THRESHOLD_PCT = 0.001;

function detectStructure(
  candles: OHLCV[],
  timeframe: '1w' | '1d' | '4h'
): { bias: StructuralBias; lastHigh: number; lastLow: number; prevHigh: number; prevLow: number } {
  const cfg = SWING_CONFIG[timeframe];

  if (candles.length < cfg.min) {
    return { bias: 'NEUTRAL', lastHigh: 0, lastLow: 0, prevHigh: 0, prevLow: 0 };
  }

  const points = swingPoints(candles, cfg.left, cfg.right, 30);
  const highs = points.filter((p) => p.type === 'HIGH').sort((a, b) => b.index - a.index);
  const lows  = points.filter((p) => p.type === 'LOW').sort((a, b) => b.index - a.index);

  if (highs.length < 2 || lows.length < 2) {
    return { bias: 'NEUTRAL', lastHigh: 0, lastLow: 0, prevHigh: 0, prevLow: 0 };
  }

  const lastHigh = highs[0].price;
  const prevHigh = highs[1].price;
  const lastLow  = lows[0].price;
  const prevLow  = lows[1].price;

  const hhConfirmed = lastHigh > prevHigh * (1 + CONFIRMATION_THRESHOLD_PCT);
  const hlConfirmed = lastLow  > prevLow  * (1 + CONFIRMATION_THRESHOLD_PCT);
  const llConfirmed = lastLow  < prevLow  * (1 - CONFIRMATION_THRESHOLD_PCT);
  const lhConfirmed = lastHigh < prevHigh * (1 - CONFIRMATION_THRESHOLD_PCT);

  let bias: StructuralBias = 'NEUTRAL';
  if (hhConfirmed && hlConfirmed) bias = 'BULLISH';
  else if (llConfirmed && lhConfirmed) bias = 'BEARISH';

  return { bias, lastHigh, lastLow, prevHigh, prevLow };
}

export function analyseMarketStructure(
  candles1w: OHLCV[],
  candles1d: OHLCV[],
  candles4h: OHLCV[]
): SwingBias {
  const weekly   = detectStructure(candles1w, '1w');
  const daily    = detectStructure(candles1d, '1d');
  const fourHour = detectStructure(candles4h, '4h');

  const biases = [weekly.bias, daily.bias, fourHour.bias];
  const bullCount = biases.filter((b) => b === 'BULLISH').length;
  const bearCount = biases.filter((b) => b === 'BEARISH').length;

  let direction: 'LONG' | 'SHORT' | null = null;
  let confidence: SwingBias['confidence'] = 'LOW';
  let agreementCount = 0;
  const notesParts: string[] = [];

  notesParts.push(`W:${weekly.bias[0]} D:${daily.bias[0]} 4H:${fourHour.bias[0]}`);

  if (bullCount === 3) {
    direction = 'LONG'; confidence = 'HIGH'; agreementCount = 3;
    notesParts.push('All 3 TFs: HH+HL confirmed');
  } else if (bearCount === 3) {
    direction = 'SHORT'; confidence = 'HIGH'; agreementCount = 3;
    notesParts.push('All 3 TFs: LH+LL confirmed');
  } else if (bullCount >= 2 && daily.bias === 'BULLISH' && fourHour.bias === 'BULLISH') {
    direction = 'LONG'; confidence = 'MEDIUM'; agreementCount = bullCount;
    notesParts.push('Daily+4H HH+HL; Weekly neutral');
  } else if (bearCount >= 2 && daily.bias === 'BEARISH' && fourHour.bias === 'BEARISH') {
    direction = 'SHORT'; confidence = 'MEDIUM'; agreementCount = bearCount;
    notesParts.push('Daily+4H LH+LL; Weekly neutral');
  } else {
    notesParts.push('Insufficient TF agreement — no swing bias');
  }

  return {
    direction,
    confidence,
    weeklyBias:   weekly.bias,
    dailyBias:    daily.bias,
    fourHourBias: fourHour.bias,
    agreementCount,
    notes: notesParts.join(' | '),
  };
}

export function findStructuralStopPoint(
  candles: OHLCV[],
  timeframe: '1d' | '4h',
  entryPrice: number,
  isLong: boolean
): { price: number; atrBuffer: number } | null {
  const cfg = SWING_CONFIG[timeframe];
  const points = swingPoints(candles, cfg.left, cfg.right, 20);

  if (isLong) {
    const swingLows = points
      .filter((p) => p.type === 'LOW' && p.price < entryPrice)
      .sort((a, b) => b.index - a.index);
    for (const sw of swingLows) {
      const dist = (entryPrice - sw.price) / entryPrice;
      if (dist >= 0.005) return { price: sw.price, atrBuffer: 0.2 };
    }
  } else {
    const swingHighs = points
      .filter((p) => p.type === 'HIGH' && p.price > entryPrice)
      .sort((a, b) => b.index - a.index);
    for (const sw of swingHighs) {
      const dist = (sw.price - entryPrice) / entryPrice;
      if (dist >= 0.005) return { price: sw.price, atrBuffer: 0.2 };
    }
  }
  return null;
}

export function findStructuralTargets(
  candles1d: OHLCV[],
  candles4h: OHLCV[],
  entryPrice: number,
  stopLoss: number,
  isLong: boolean
): { primary: number | null; extended: number | null } {
  const stopDist = Math.abs(entryPrice - stopLoss);
  if (stopDist === 0) return { primary: null, extended: null };

  const dailyCfg = SWING_CONFIG['1d'];
  const fourHCfg = SWING_CONFIG['4h'];
  const dailyPoints = swingPoints(candles1d, dailyCfg.left, dailyCfg.right, 20);
  const fourHPoints = swingPoints(candles4h, fourHCfg.left, fourHCfg.right, 20);
  const allPoints = [...dailyPoints, ...fourHPoints];

  function deduplicateLevels(levels: number[], tolerancePct: number): number[] {
    const result: number[] = [];
    for (const level of levels) {
      if (result.length === 0) { result.push(level); continue; }
      const prev = result[result.length - 1];
      if (Math.abs(level - prev) / prev > tolerancePct) result.push(level);
    }
    return result;
  }

  if (isLong) {
    const targets = allPoints
      .filter((p) => p.type === 'HIGH' && p.price > entryPrice)
      .map((p) => p.price)
      .sort((a, b) => a - b);
    const deduped = deduplicateLevels(targets, 0.005);
    let primary: number | null = null;
    let extended: number | null = null;
    for (const t of deduped) {
      const rr = (t - entryPrice) / stopDist;
      if (rr >= 2.5 && primary === null) primary = t;
      else if (rr >= 3.0 && extended === null) extended = t;
      if (primary !== null && extended !== null) break;
    }
    return { primary, extended };
  } else {
    const targets = allPoints
      .filter((p) => p.type === 'LOW' && p.price < entryPrice)
      .map((p) => p.price)
      .sort((a, b) => b - a);
    const deduped = deduplicateLevels(targets, 0.005);
    let primary: number | null = null;
    let extended: number | null = null;
    for (const t of deduped) {
      const rr = (entryPrice - t) / stopDist;
      if (rr >= 2.5 && primary === null) primary = t;
      else if (rr >= 3.0 && extended === null) extended = t;
      if (primary !== null && extended !== null) break;
    }
    return { primary, extended };
  }
}
