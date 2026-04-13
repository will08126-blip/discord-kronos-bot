/**
 * Indicator result cache
 *
 * Uses WeakMap keyed on OHLCV array references so results are automatically
 * released when a candles array goes out of scope (after each scan cycle).
 * All strategies receive the same array references from the engine, so they
 * share results — zero redundant recomputation per asset per cycle.
 *
 * Usage — swap `ema(candles, 20)` for `cachedEma(candles, 20)` etc.
 */
import type { OHLCV } from '../types';
import { ema, rsi, atr, atrAverage, vwap, macd, detectFVGs, emaQuickTrend, bollinger } from './indicators';
import type { MACDResult, FVGZone, BollingerResult } from './indicators';

const store = new WeakMap<OHLCV[], Map<string, unknown>>();

function get<T>(candles: OHLCV[], key: string, compute: () => T): T {
  let inner = store.get(candles);
  if (!inner) {
    inner = new Map();
    store.set(candles, inner);
  }
  if (!inner.has(key)) inner.set(key, compute());
  return inner.get(key) as T;
}

export const cachedEma = (candles: OHLCV[], period: number): number[] =>
  get(candles, `ema_${period}`, () => ema(candles, period));

export const cachedRsi = (candles: OHLCV[], period: number): number[] =>
  get(candles, `rsi_${period}`, () => rsi(candles, period));

export const cachedAtr = (candles: OHLCV[], period: number): number[] =>
  get(candles, `atr_${period}`, () => atr(candles, period));

/**
 * Returns the rolling average of the ATR series (last `period` values).
 * Internally reuses the cached ATR array — no double computation.
 */
export const cachedAtrAverage = (candles: OHLCV[], period: number): number =>
  get(candles, `atrAvg_${period}`, () => atrAverage(cachedAtr(candles, period), period));

export const cachedVwap = (candles: OHLCV[]): number[] =>
  get(candles, 'vwap', () => vwap(candles));

export const cachedMacd = (
  candles: OHLCV[],
  fast = 12,
  slow = 26,
  signal = 9,
): MACDResult =>
  get(candles, `macd_${fast}_${slow}_${signal}`, () => macd(candles, fast, slow, signal));

export const cachedFVGs = (candles: OHLCV[], maxZones = 5): FVGZone[] =>
  get(candles, `fvg_${maxZones}`, () => detectFVGs(candles, maxZones));

export const cachedEmaQuickTrend = (
  candles: OHLCV[],
  fast = 8,
  slow = 21,
): 'UP' | 'DOWN' | 'NEUTRAL' =>
  get(candles, `emaQt_${fast}_${slow}`, () => emaQuickTrend(candles, fast, slow));

export const cachedBollinger = (
  candles: OHLCV[],
  period = 20,
  stdDev = 2,
): BollingerResult =>
  get(candles, `bb_${period}_${stdDev}`, () => bollinger(candles, period, stdDev));
