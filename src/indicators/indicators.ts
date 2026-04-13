import {
  EMA,
  RSI,
  ATR as ATRCalc,
  ADX as ADXCalc,
  BollingerBands,
} from 'technicalindicators';
import type { OHLCV } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function closes(candles: OHLCV[]): number[] {
  return candles.map((c) => c.close);
}

function highs(candles: OHLCV[]): number[] {
  return candles.map((c) => c.high);
}

function lows(candles: OHLCV[]): number[] {
  return candles.map((c) => c.low);
}

function volumes(candles: OHLCV[]): number[] {
  return candles.map((c) => c.volume);
}

/** Pad result array with NaN at the front so it aligns with input array length */
function pad<T>(arr: T[], targetLen: number, fill: T): T[] {
  const diff = targetLen - arr.length;
  return [...Array(diff).fill(fill), ...arr];
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

export function ema(candles: OHLCV[], period: number): number[] {
  const result = EMA.calculate({ period, values: closes(candles) });
  return pad(result, candles.length, NaN);
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

export function rsi(candles: OHLCV[], period = 14): number[] {
  const result = RSI.calculate({ period, values: closes(candles) });
  return pad(result, candles.length, NaN);
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

export function atr(candles: OHLCV[], period = 14): number[] {
  const result = ATRCalc.calculate({
    period,
    high: highs(candles),
    low: lows(candles),
    close: closes(candles),
  });
  return pad(result, candles.length, NaN);
}

/** Average of the ATR values (excluding NaN) */
export function atrAverage(atrValues: number[], lookback = 14): number {
  const valid = atrValues.filter((v) => !isNaN(v)).slice(-lookback);
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// ─── ADX ─────────────────────────────────────────────────────────────────────

export interface ADXResult {
  adx: number[];
  pdi: number[]; // +DI
  mdi: number[]; // -DI
}

export function adx(candles: OHLCV[], period = 14): ADXResult {
  const result = ADXCalc.calculate({
    period,
    high: highs(candles),
    low: lows(candles),
    close: closes(candles),
  });
  const adxVals = pad(result.map((r) => r.adx), candles.length, NaN);
  const pdiVals = pad(result.map((r) => r.pdi), candles.length, NaN);
  const mdiVals = pad(result.map((r) => r.mdi), candles.length, NaN);
  return { adx: adxVals, pdi: pdiVals, mdi: mdiVals };
}

// ─── Bollinger Bands ─────────────────────────────────────────────────────────

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[];  // (upper - lower) / middle — normalised band width
}

export function bollinger(
  candles: OHLCV[],
  period = 20,
  stdDev = 2
): BollingerResult {
  const result = BollingerBands.calculate({
    period,
    values: closes(candles),
    stdDev,
  });
  const upper = pad(result.map((r) => r.upper), candles.length, NaN);
  const middle = pad(result.map((r) => r.middle), candles.length, NaN);
  const lower = pad(result.map((r) => r.lower), candles.length, NaN);
  const width = upper.map((u, i) =>
    isNaN(u) ? NaN : (u - lower[i]) / middle[i]
  );
  return { upper, middle, lower, width };
}

/**
 * Minimum Bollinger width over the last `lookback` candles (squeeze detector).
 * Returns Infinity when there is insufficient valid data (< 75% of lookback),
 * which callers should treat as "no squeeze data available".
 */
export function bollingerWidthMin(width: number[], lookback = 20): number {
  const valid = width.filter((v) => !isNaN(v)).slice(-lookback);
  if (valid.length < Math.floor(lookback * 0.75)) return Infinity;
  return Math.min(...valid);
}

// ─── VWAP (session-based, resets each day) ───────────────────────────────────

export function vwap(candles: OHLCV[]): number[] {
  const result: number[] = [];
  let cumulativeTPV = 0;
  let cumulativeVol = 0;
  let lastDay = -1;

  for (const c of candles) {
    const day = new Date(c.time).getUTCDate();
    if (day !== lastDay) {
      cumulativeTPV = 0;
      cumulativeVol = 0;
      lastDay = day;
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumulativeTPV += tp * c.volume;
    cumulativeVol += c.volume;
    result.push(cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : c.close);
  }
  return result;
}

// ─── Swing High / Low Detection ──────────────────────────────────────────────

export interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

/**
 * Detect swing highs and lows using a simple left/right comparison window.
 * Returns the last `maxPoints` found.
 */
export function swingPoints(
  candles: OHLCV[],
  leftBars = 3,
  rightBars = 3,
  maxPoints = 10
): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) points.push({ index: i, price: c.high, type: 'HIGH' });
    if (isLow) points.push({ index: i, price: c.low, type: 'LOW' });
  }
  return points.slice(-maxPoints);
}

// ─── Volume helpers ──────────────────────────────────────────────────────────

export function volumeAverage(candles: OHLCV[], lookback = 20): number {
  const vols = volumes(candles).slice(-lookback);
  if (vols.length === 0) return 0;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

/** Returns true if the last candle's volume is above the average by ratio */
export function isVolumeSpike(candles: OHLCV[], ratio = 1.5, lookback = 20): boolean {
  const avg = volumeAverage(candles, lookback);
  const last = candles[candles.length - 1].volume;
  return last >= avg * ratio;
}

// ─── Candle pattern helpers ───────────────────────────────────────────────────

export function isBullishEngulfing(candles: OHLCV[]): boolean {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  return (
    prev.close < prev.open &&
    curr.close > curr.open &&
    curr.open < prev.close &&
    curr.close > prev.open
  );
}

export function isBearishEngulfing(candles: OHLCV[]): boolean {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  return (
    prev.close > prev.open &&
    curr.close < curr.open &&
    curr.open > prev.close &&
    curr.close < prev.open
  );
}

/** Pin bar: wick is at least 2× the body size, body near one end */
export function isBullishPin(candle: OHLCV): boolean {
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return lowerWick >= body * 2 && lowerWick > upperWick * 2;
}

export function isBearishPin(candle: OHLCV): boolean {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return upperWick >= body * 2 && upperWick > lowerWick * 2;
}

// ─── RSI divergence ──────────────────────────────────────────────────────────

/**
 * Bullish divergence: most-recent swing low is lower in price but higher in RSI
 * than the previous swing low (candles 10–20 back).
 *
 * Two-pass approach avoids the backward-iteration bug where the algorithm
 * could never set prevLow when the most-recent candles hold the new low.
 */
export function hasBullishDivergence(candles: OHLCV[], rsiValues: number[]): boolean {
  const n = candles.length;
  if (n < 20) return false;

  // Pass 1: find the lowest point in the most-recent 10 candles
  let recentIdx = -1;
  let recentPrice = Infinity;
  for (let i = n - 1; i >= n - 10; i--) {
    if (candles[i].low < recentPrice) {
      recentIdx = i;
      recentPrice = candles[i].low;
    }
  }
  if (recentIdx === -1) return false;

  // Pass 2: find the lowest point in the 10 candles before that window
  let prevIdx = -1;
  let prevPrice = Infinity;
  const pass2End = Math.max(0, n - 20);
  for (let i = n - 11; i >= pass2End; i--) {
    if (candles[i].low < prevPrice) {
      prevIdx = i;
      prevPrice = candles[i].low;
    }
  }
  if (prevIdx === -1) return false;

  // Bullish divergence: price lower low + RSI higher low
  return recentPrice < prevPrice && rsiValues[recentIdx] > rsiValues[prevIdx];
}

/**
 * Bearish divergence: most-recent swing high is higher in price but lower in RSI
 * than the previous swing high (candles 10–20 back).
 */
export function hasBearishDivergence(candles: OHLCV[], rsiValues: number[]): boolean {
  const n = candles.length;
  if (n < 20) return false;

  // Pass 1: find the highest point in the most-recent 10 candles
  let recentIdx = -1;
  let recentPrice = -Infinity;
  for (let i = n - 1; i >= n - 10; i--) {
    if (candles[i].high > recentPrice) {
      recentIdx = i;
      recentPrice = candles[i].high;
    }
  }
  if (recentIdx === -1) return false;

  // Pass 2: find the highest point in the 10 candles before that window
  let prevIdx = -1;
  let prevPrice = -Infinity;
  const pass2End = Math.max(0, n - 20);
  for (let i = n - 11; i >= pass2End; i--) {
    if (candles[i].high > prevPrice) {
      prevIdx = i;
      prevPrice = candles[i].high;
    }
  }
  if (prevIdx === -1) return false;

  // Bearish divergence: price higher high + RSI lower high
  return recentPrice > prevPrice && rsiValues[recentIdx] < rsiValues[prevIdx];
}

// ─── Session quality ──────────────────────────────────────────────────────────

/**
 * Returns a session quality score (0-5).
 * London open: 08:00-12:00 UTC
 * NY open: 13:00-17:00 UTC
 * Overlap: 13:00-16:00 UTC (highest quality)
 * Asia: 00:00-08:00 UTC (lower quality)
 * Weekend: reduced quality
 */
export function sessionQualityScore(): number {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return 1;

  const hour = now.getUTCHours();
  if (hour >= 13 && hour < 16) return 5; // NY/London overlap (highest quality)
  if (hour >= 8  && hour < 12) return 5; // London open
  if (hour >= 16 && hour < 17) return 4; // NY only (post-overlap)
  if (hour >= 12 && hour < 13) return 3; // lunch (12–13 UTC)
  if (hour >= 0  && hour < 8 ) return 2; // Asia
  return 3; // everything else (late NY 17–24 UTC)
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

export interface MACDResult {
  macdLine: number[];    // fast EMA - slow EMA
  signalLine: number[];  // EMA of macdLine
  histogram: number[];   // macdLine - signalLine
}

/**
 * MACD indicator.
 * Default params: fast=12, slow=26, signal=9 (standard)
 * For scalp use fast=5, slow=13, signal=3 (more responsive)
 *
 * All output arrays are padded to input candle length with NaN.
 */
export function macd(
  candles: OHLCV[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const cls = closes(candles);
  const n = cls.length;

  // Fast and slow EMAs (use library)
  const fastEma = pad(
    EMA.calculate({ period: fastPeriod, values: cls }),
    n,
    NaN,
  );
  const slowEma = pad(
    EMA.calculate({ period: slowPeriod, values: cls }),
    n,
    NaN,
  );

  // MACD line = fast - slow (only valid where both exist)
  const macdLine: number[] = fastEma.map((f, i) =>
    isNaN(f) || isNaN(slowEma[i]) ? NaN : f - slowEma[i],
  );

  // Signal line = EMA of MACD line (skip NaN prefix)
  const validMacd = macdLine.filter((v) => !isNaN(v));
  const rawSignal =
    validMacd.length >= signalPeriod
      ? EMA.calculate({ period: signalPeriod, values: validMacd })
      : [];

  // How many leading NaNs are in macdLine?
  const macdOffset = macdLine.findIndex((v) => !isNaN(v));
  const signalLine: number[] = Array(n).fill(NaN);
  const sigOffset = macdOffset + (validMacd.length - rawSignal.length);
  for (let i = 0; i < rawSignal.length; i++) {
    signalLine[sigOffset + i] = rawSignal[i];
  }

  const histogram: number[] = macdLine.map((m, i) =>
    isNaN(m) || isNaN(signalLine[i]) ? NaN : m - signalLine[i],
  );

  return { macdLine, signalLine, histogram };
}

// ─── Fair Value Gap (FVG) ─────────────────────────────────────────────────────

export interface FVGZone {
  type: 'BULLISH' | 'BEARISH';
  gapHigh: number;   // top of the imbalance zone
  gapLow: number;    // bottom of the imbalance zone
  midpoint: number;
  candle1Index: number; // index of the first candle of the 3-candle sequence
  strength: number;     // gap size as % of price — larger = stronger
  filled: boolean;      // true if price has since re-entered the zone
}

/**
 * Detects Fair Value Gaps (FVGs / imbalances) in a candle array.
 *
 * Bullish FVG: candles[i-2].high < candles[i].low
 *   → price gapped up leaving an unfilled zone between i-2 high and i low.
 *
 * Bearish FVG: candles[i-2].low > candles[i].high
 *   → price gapped down leaving an unfilled zone between i-2 low and i high.
 *
 * Only returns the most recent `maxZones` unfilled FVGs, sorted newest-first.
 */
export function detectFVGs(candles: OHLCV[], maxZones = 5): FVGZone[] {
  const n = candles.length;
  if (n < 3) return [];

  const zones: FVGZone[] = [];

  for (let i = 2; i < n; i++) {
    const prev2 = candles[i - 2]; // candle before the impulse
    const curr  = candles[i];     // candle after the impulse

    // Bullish FVG
    if (prev2.high < curr.low) {
      const gapLow  = prev2.high;
      const gapHigh = curr.low;
      const mid     = (gapLow + gapHigh) / 2;
      const strength = (gapHigh - gapLow) / mid;

      // Check if any subsequent candle filled this zone
      let filled = false;
      for (let j = i + 1; j < n; j++) {
        if (candles[j].low <= gapHigh && candles[j].high >= gapLow) {
          filled = true;
          break;
        }
      }
      zones.push({ type: 'BULLISH', gapHigh, gapLow, midpoint: mid, candle1Index: i - 2, strength, filled });
    }

    // Bearish FVG
    if (prev2.low > curr.high) {
      const gapHigh = prev2.low;
      const gapLow  = curr.high;
      const mid     = (gapLow + gapHigh) / 2;
      const strength = (gapHigh - gapLow) / mid;

      let filled = false;
      for (let j = i + 1; j < n; j++) {
        if (candles[j].low <= gapHigh && candles[j].high >= gapLow) {
          filled = true;
          break;
        }
      }
      zones.push({ type: 'BEARISH', gapHigh, gapLow, midpoint: mid, candle1Index: i - 2, strength, filled });
    }
  }

  // Return most-recent unfilled zones first
  return zones
    .filter((z) => !z.filled)
    .slice(-maxZones)
    .reverse();
}

/**
 * Returns true if `price` is currently inside (or very close to) an FVG zone.
 * `tolerancePct` widens the zone slightly to account for wicks / rounding.
 */
export function isPriceInFVG(price: number, zone: FVGZone, tolerancePct = 0.001): boolean {
  return price >= zone.gapLow * (1 - tolerancePct) && price <= zone.gapHigh * (1 + tolerancePct);
}

// ─── Higher-timeframe trend filter ───────────────────────────────────────────

/**
 * Quick MTF trend check: returns 'UP', 'DOWN', or 'NEUTRAL' based on
 * whether EMA8 > EMA21 (up) or EMA8 < EMA21 (down) on a given candle array.
 * Used by the ScalpFVG strategy to gate entries against 5m / 15m trend.
 */
export function emaQuickTrend(candles: OHLCV[], fastPeriod = 8, slowPeriod = 21): 'UP' | 'DOWN' | 'NEUTRAL' {
  const n = candles.length;
  if (n < slowPeriod + 1) return 'NEUTRAL';
  const fastEma = pad(EMA.calculate({ period: fastPeriod, values: closes(candles) }), n, NaN);
  const slowEma = pad(EMA.calculate({ period: slowPeriod, values: closes(candles) }), n, NaN);
  const f = fastEma[n - 1];
  const s = slowEma[n - 1];
  if (isNaN(f) || isNaN(s)) return 'NEUTRAL';
  if (f > s * 1.0002) return 'UP';
  if (f < s * 0.9998) return 'DOWN';
  return 'NEUTRAL';
}
