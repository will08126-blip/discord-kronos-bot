/**
 * Pro-grade swing trade analysis helpers.
 *
 * These functions replace the naive "min/max of last N candles" approach with
 * actual market-structure analysis on the 4h timeframe — the way a professional
 * swing trader actually reads the chart:
 *
 *  1. STOP  — placed just below the most recent confirmed 4h swing LOW (for longs),
 *             identified via left/right bar comparison (not raw range minimum).
 *             This anchors the stop at a real invalidation level, not an arbitrary ATR band.
 *
 *  2. TP    — targets the next structural 4h swing HIGH above entry (for longs),
 *             so long as it offers at least 2:1 R:R. Falls back to the fixed R:R
 *             multiplier if no structural level is available.
 *
 *  3. RSI   — 4h RSI must be in the "swing-entry zone" (35–65). Entering when 4h
 *             is overbought / oversold dramatically lowers swing accuracy.
 *
 *  4. EMA   — Rewards entries near the 4h EMA20/EMA50 (dynamic support/resistance)
 *             and full triple-stack alignment (EMA20 > EMA50 > EMA200 for longs),
 *             producing a properly-calibrated htfAlignment score for swing signals.
 */

import { swingPoints } from '../indicators/indicators';
import { cachedRsi, cachedEma } from '../indicators/cache';
import type { OHLCV } from '../types';

// ── Tuneable constants ────────────────────────────────────────────────────────

/** 4h candles looked back for swing stop identification (~3.3 days). */
const STOP_LOOKBACK_4H = 20;

/** 4h candles looked back for swing TP identification (~5 days). */
const TP_LOOKBACK_4H = 30;

/** Bars each side required to confirm a 4h swing point (2 bars = 8 h confirmation). */
const SWING_LEFT = 2;
const SWING_RIGHT = 2;

/** Stop must be 1.5–6% from entry to qualify as SWING. */
const SWING_MIN_PCT = 0.015;
const SWING_MAX_PCT = 0.06;

/** Structural TP must offer at least this R:R ratio. */
const MIN_RR_FOR_STRUCTURAL_TP = 2.0;

/** 4h RSI range that is acceptable for swing entries. */
const RSI_SWING_LO = 35;
const RSI_SWING_HI = 65;

/** Price must be within this % of 4h EMA to be considered "at the EMA". */
const EMA_PROXIMITY_PCT = 0.025;

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Find the structural 4h stop for a swing trade.
 *
 * For LONG: locates the most recent confirmed 4h swing LOW below `entryMid`
 * and places the stop 0.2×ATR below it.
 * For SHORT: same logic inverted using swing HIGHs.
 *
 * Returns null if no suitable structural level is found within the valid
 * stop-distance range (1.5–6% from entry).
 */
export function findSwing4hStop(
  candles4h: OHLCV[],
  entryMid: number,
  isLong: boolean,
  atr4h: number
): number | null {
  if (candles4h.length < STOP_LOOKBACK_4H + SWING_RIGHT + 2) return null;

  const recent = candles4h.slice(-STOP_LOOKBACK_4H);
  const swings = swingPoints(recent, SWING_LEFT, SWING_RIGHT, 10);

  if (isLong) {
    // All confirmed swing lows below entry, most-recent first
    const lows = swings
      .filter((s) => s.type === 'LOW' && s.price < entryMid)
      .sort((a, b) => b.index - a.index);

    for (const swing of lows) {
      const stop = swing.price - atr4h * 0.2;
      const pct = (entryMid - stop) / entryMid;
      if (pct >= SWING_MIN_PCT && pct <= SWING_MAX_PCT) return stop;
    }
  } else {
    // All confirmed swing highs above entry, most-recent first
    const highs = swings
      .filter((s) => s.type === 'HIGH' && s.price > entryMid)
      .sort((a, b) => b.index - a.index);

    for (const swing of highs) {
      const stop = swing.price + atr4h * 0.2;
      const pct = (stop - entryMid) / entryMid;
      if (pct >= SWING_MIN_PCT && pct <= SWING_MAX_PCT) return stop;
    }
  }

  return null;
}

/**
 * Find the structural 4h take-profit target for a swing trade.
 *
 * For LONG: finds the nearest 4h swing HIGH above entry that offers at
 * least MIN_RR_FOR_STRUCTURAL_TP:1 reward-to-risk relative to `stopLoss`.
 * For SHORT: inverted.
 *
 * Returns null if no suitable structural target is found — the caller
 * should fall back to the fixed R:R multiplier in that case.
 */
export function findSwing4hTP(
  candles4h: OHLCV[],
  entryMid: number,
  stopLoss: number,
  isLong: boolean
): number | null {
  if (candles4h.length < TP_LOOKBACK_4H + SWING_RIGHT + 2) return null;

  const recent = candles4h.slice(-TP_LOOKBACK_4H);
  const swings = swingPoints(recent, SWING_LEFT, SWING_RIGHT, 12);
  const stopDist = Math.abs(entryMid - stopLoss);
  if (stopDist === 0) return null;

  if (isLong) {
    // Nearest swing HIGH above entry with acceptable R:R, sorted closest first
    const highs = swings
      .filter((s) => s.type === 'HIGH' && s.price > entryMid)
      .sort((a, b) => a.price - b.price);

    for (const swing of highs) {
      if ((swing.price - entryMid) / stopDist >= MIN_RR_FOR_STRUCTURAL_TP) {
        return swing.price;
      }
    }
  } else {
    // Nearest swing LOW below entry with acceptable R:R, sorted closest first
    const lows = swings
      .filter((s) => s.type === 'LOW' && s.price < entryMid)
      .sort((a, b) => b.price - a.price);

    for (const swing of lows) {
      if ((entryMid - swing.price) / stopDist >= MIN_RR_FOR_STRUCTURAL_TP) {
        return swing.price;
      }
    }
  }

  return null;
}

/**
 * 4h RSI gate and scoring for swing entries.
 *
 * A swing entered when 4h RSI is overbought/oversold has historically poor
 * follow-through. This check keeps swing signals in the "room to run" zone.
 *
 * Returns:
 *  - `favorable` — true if RSI is within RSI_SWING_LO–RSI_SWING_HI
 *  - `rsi4h`     — the raw RSI value (for notes)
 *  - `rsiScore`  — 0–10 score for the volatilityQuality component:
 *                  10 = centre of ideal range (45–55)
 *                  7  = good range
 *                  4  = acceptable but extended
 *                  0  = unfavorable (overbought/oversold)
 */
export function swingRsiCheck(
  candles4h: OHLCV[],
  isLong: boolean
): { favorable: boolean; rsi4h: number; rsiScore: number } {
  const rsiVals = cachedRsi(candles4h, 14);
  const rsi4h = rsiVals[rsiVals.length - 1] ?? 50;

  // Directional nuance: slightly more room on the "entry side"
  // Longs: RSI 35–65 — pulled back but not capitulated, room to recover
  // Shorts: RSI 35–65 — bounced but not in full-bull mode, room to roll over
  const favorable = isLong
    ? rsi4h >= RSI_SWING_LO && rsi4h <= RSI_SWING_HI
    : rsi4h >= RSI_SWING_LO && rsi4h <= RSI_SWING_HI;

  const distFromCenter = Math.abs(rsi4h - 50);
  const rsiScore = favorable
    ? distFromCenter <= 10 ? 10 : distFromCenter <= 20 ? 7 : 4
    : 0;

  return { favorable, rsi4h, rsiScore };
}

/**
 * 4h EMA confluence scoring for swing trades.
 *
 * Produces a properly-calibrated `htfAlignment` score (0–20) that reflects:
 *  - Full triple-stack alignment (EMA20 > EMA50 > EMA200): highest scores
 *  - Price proximity to 4h EMA20 or EMA50: bonus (dynamic S/R)
 *  - Misaligned EMAs: low score
 *
 * Also returns `nearKeyEma` so the caller can apply a `setupQuality` bonus
 * when price is bouncing off a real dynamic support/resistance level.
 */
export function swingEmaScore(
  candles4h: OHLCV[],
  entryMid: number,
  isLong: boolean
): { htfScore: number; nearKeyEma: boolean } {
  if (candles4h.length < 202) {
    // Not enough data for EMA200 — can still evaluate with partial data
    const ema20 = cachedEma(candles4h, 20);
    const ema50 = cachedEma(candles4h, 50);
    const n = candles4h.length - 1;
    const e20 = ema20[n];
    const e50 = ema50[n];
    const basicAligned = isLong ? e20 > e50 : e20 < e50;
    const nearEma20 = Math.abs(entryMid - e20) / e20 < EMA_PROXIMITY_PCT;
    const nearEma50 = Math.abs(entryMid - e50) / e50 < EMA_PROXIMITY_PCT;
    const nearKeyEma = nearEma20 || nearEma50;
    const htfScore = basicAligned ? (nearKeyEma ? 13 : 10) : 5;
    return { htfScore, nearKeyEma };
  }

  const ema20 = cachedEma(candles4h, 20);
  const ema50 = cachedEma(candles4h, 50);
  const ema200 = cachedEma(candles4h, 200);
  const n = candles4h.length - 1;

  const e20 = ema20[n];
  const e50 = ema50[n];
  const e200 = ema200[n];

  const tripleAligned = isLong
    ? e20 > e50 && e50 > e200
    : e20 < e50 && e50 < e200;

  const basicAligned = isLong ? e20 > e50 : e20 < e50;

  const nearEma20 = !isNaN(e20) && Math.abs(entryMid - e20) / e20 < EMA_PROXIMITY_PCT;
  const nearEma50 = !isNaN(e50) && Math.abs(entryMid - e50) / e50 < EMA_PROXIMITY_PCT;
  const nearKeyEma = nearEma20 || nearEma50;

  let htfScore: number;
  if (tripleAligned && nearKeyEma)  htfScore = 20;  // gold standard: bouncing off EMA in a clean trend
  else if (tripleAligned)           htfScore = 17;  // full stack aligned — strong trend
  else if (basicAligned && nearKeyEma) htfScore = 14; // good trend, at dynamic S/R
  else if (basicAligned)            htfScore = 10;  // trend aligned, not at key EMA
  else                              htfScore = 5;   // misaligned — penalised

  return { htfScore, nearKeyEma };
}
