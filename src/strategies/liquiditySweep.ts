import { v4 as uuidv4 } from 'uuid';
import { BaseStrategy } from './base';
import {
  swingPoints,
  hasBullishDivergence,
  hasBearishDivergence,
  isBullishEngulfing,
  isBearishEngulfing,
  sessionQualityScore,
  isVolumeSpike,
} from '../indicators/indicators';
import { cachedEma, cachedAtr, cachedAtrAverage, cachedRsi } from '../indicators/cache';
import { findSwing4hStop, findSwing4hTP, swingEmaScore } from './swingHelpers';
import type { StrategySignal, MultiTimeframeData, Regime, ScoreTier, TradeType } from '../types';


/**
 * Liquidity Sweep Reversal Strategy
 *
 * Logic:
 *  - Detect swing highs/lows on 15m (last 20 candles)
 *  - Sweep: wick extends beyond swing by > 0.2%, body closes back inside range
 *  - Confirmation: RSI divergence or engulfing reversal candle
 *
 * Suitable for: RANGE, TREND_UP (end), TREND_DOWN (end)
 *
 * Counter-trend sweeps (e.g. bullish reversal in TREND_DOWN) are still allowed
 * but scored lower — they can work in choppy markets, just less reliable.
 */
export class LiquiditySweepStrategy extends BaseStrategy {
  readonly name = 'Liquidity Sweep';
  readonly supportedRegimes: Regime[] = ['RANGE', 'TREND_UP', 'TREND_DOWN'];

  analyze(data: MultiTimeframeData, regime: Regime): StrategySignal | null {
    if (!this.isRegimeSupported(regime)) return null;

    const candles4h = data['4h'];
    const candles15m = data['15m'];
    const candles5m = data['5m'];

    if (candles4h.length < 14 || candles15m.length < 30 || candles5m.length < 20) return null;

    const lastAtr4h = cachedAtr(candles4h, 14)[candles4h.length - 1];

    const atrVals15m = cachedAtr(candles15m, 14);
    const lastAtr15m = atrVals15m[candles15m.length - 1];
    const avgAtr15m = cachedAtrAverage(candles15m, 14);

    const avgAtr5m = cachedAtrAverage(candles5m, 14);
    const lastAtr5m = cachedAtr(candles5m, 14)[candles5m.length - 1];

    const rsiVals15m = cachedRsi(candles15m, 14);
    // Pre-compute RSI on 5m ONCE here — passed into the inner loop so it is
    // never recomputed per swing level (was previously called inside a nested loop).
    const rsiVals5m = cachedRsi(candles5m, 14);

    // ── 4H trend direction (for counter-trend detection) ────────────────────
    const ema20_4h = cachedEma(candles4h, 20);
    const ema50_4h = cachedEma(candles4h, 50);
    const n4h = candles4h.length - 1;
    const trend4hUp   = ema20_4h[n4h] > ema50_4h[n4h];
    const trend4hDown = ema20_4h[n4h] < ema50_4h[n4h];

    // ── Find swing highs/lows on 15m (last 20 candles) ─────────────────────
    const swings = swingPoints(candles15m.slice(-20), 3, 3, 10);

    const recentHighSwings = swings.filter((s) => s.type === 'HIGH');
    const recentLowSwings  = swings.filter((s) => s.type === 'LOW');

    // Bullish reversal signal: sweep of lows then bounce up
    const bullSignal = this.checkSweepReversal(
      candles15m,
      candles5m,
      rsiVals15m,
      rsiVals5m,
      recentLowSwings.map((s) => s.price),
      lastAtr15m,
      lastAtr5m,
      avgAtr5m,
      lastAtr4h,
      true,
      regime,
      trend4hUp,
      trend4hDown,
      candles4h,
      data['1m']
    );
    if (bullSignal) return { ...bullSignal, asset: data.asset };

    // Bearish reversal signal: sweep of highs then drop
    const bearSignal = this.checkSweepReversal(
      candles15m,
      candles5m,
      rsiVals15m,
      rsiVals5m,
      recentHighSwings.map((s) => s.price),
      lastAtr15m,
      lastAtr5m,
      avgAtr5m,
      lastAtr4h,
      false,
      regime,
      trend4hUp,
      trend4hDown,
      candles4h,
      data['1m']
    );
    if (bearSignal) return { ...bearSignal, asset: data.asset };

    return null;
  }

  private checkSweepReversal(
    candles15m: any[],
    candles5m: any[],
    rsiVals15m: number[],
    rsiVals5m: number[],   // pre-computed outside the loop — no redundant recalculation
    swingPrices: number[],
    lastAtr15m: number,
    lastAtr5m: number,
    avgAtr5m: number,
    lastAtr4h: number,
    isBullReversal: boolean,
    regime: Regime,
    trend4hUp: boolean,
    trend4hDown: boolean,
    candles4h: any[],
    candles1m?: any[]
  ): StrategySignal | null {
    const n15 = candles15m.length - 1;

    // Counter-trend: bullish reversal in a clear downtrend (or vice versa).
    // Not a hard block — sweeps can work even against the HTF trend in RANGE —
    // but it is penalised in the regime score below.
    const isCounterTrend =
      (isBullReversal && trend4hDown) ||
      (!isBullReversal && trend4hUp);

    for (const swingLevel of swingPrices) {
      // Check last 2 candles on 15m for sweep
      for (let i = n15; i >= n15 - 2; i--) {
        if (i < 0) break;
        const c = candles15m[i];
        const sweepThreshold = swingLevel * 0.002; // 0.2%

        // Bullish reversal: wick below swing low, body closes above
        const isSweepBull =
          isBullReversal &&
          c.low < swingLevel - sweepThreshold &&
          c.close > swingLevel;

        // Bearish reversal: wick above swing high, body closes below
        const isSweepBear =
          !isBullReversal &&
          c.high > swingLevel + sweepThreshold &&
          c.close < swingLevel;

        if (!isSweepBull && !isSweepBear) continue;

        // Confirmation on 5m — rsiVals5m already computed, reuse it here
        const n5 = candles5m.length - 1;
        const lastCandle5m = candles5m[n5];

        const confirmed =
          isBullReversal
            ? isBullishEngulfing(candles5m.slice(-3)) ||
              hasBullishDivergence(candles5m.slice(-20), rsiVals5m.slice(-20))
            : isBearishEngulfing(candles5m.slice(-3)) ||
              hasBearishDivergence(candles5m.slice(-20), rsiVals5m.slice(-20));

        if (!confirmed) continue;

        // Strong wick ratio
        const wickSize = isBullReversal
          ? swingLevel - c.low
          : c.high - swingLevel;
        const bodySize = Math.abs(c.close - c.open);
        const wickRatio = bodySize > 0 ? wickSize / bodySize : 0;

        // Build signal
        const entryMid = lastCandle5m.close;

        // SL: try three modes — SCALP (1m) → SWING (4h) → HYBRID (sweep wick)
        // HYBRID is the default; scalp/swing override when their conditions are met.
        let stopLoss: number = isBullReversal
          ? c.low - avgAtr5m * 0.7
          : c.high + avgAtr5m * 0.7;
        let stopModeSet = false;

        // SCALP: stop behind 3-candle 1m swing + 0.2×ATR1m
        if (!stopModeSet && candles1m && candles1m.length >= 5) {
          const n1 = candles1m.length - 1;
          const lastAtr1m = cachedAtr(candles1m, 14)[n1];
          const lastCandle1m = candles1m[n1];
          const recent1m = candles1m.slice(-3);
          const scalp1mLow  = Math.min(...recent1m.map((cv: any) => cv.low));
          const scalp1mHigh = Math.max(...recent1m.map((cv: any) => cv.high));
          const scalpStop = isBullReversal ? scalp1mLow - lastAtr1m * 0.2 : scalp1mHigh + lastAtr1m * 0.2;
          const scalpPct  = Math.abs(entryMid - scalpStop) / entryMid;
          const body1m    = Math.abs(lastCandle1m.close - lastCandle1m.open);
          if (scalpPct < 0.003 && body1m > lastAtr1m * 0.3) {
            stopLoss = scalpStop;
            stopModeSet = true;
          }
        }

        // SWING: structural 4h stop from real swing-point analysis (pro-grade placement)
        if (!stopModeSet) {
          const swingStop = findSwing4hStop(candles4h, entryMid, isBullReversal, lastAtr4h);
          if (swingStop !== null) {
            stopLoss = swingStop;
            stopModeSet = true;
          }
        }
        // HYBRID default already set above; stopModeSet flag is no longer needed below

        const stopDistance = Math.abs(entryMid - stopLoss);
        const stopPct = entryMid > 0 ? stopDistance / entryMid : 0;
        const tradeType: TradeType = stopPct < 0.003 ? 'SCALP' : stopPct < 0.015 ? 'HYBRID' : 'SWING';
        const rrMultiplier = tradeType === 'SCALP' ? 4.0 : tradeType === 'HYBRID' ? 3.0 : 2.5;
        let takeProfit = isBullReversal ? entryMid + stopDistance * rrMultiplier : entryMid - stopDistance * rrMultiplier;
        if (tradeType === 'SWING') {
          const structTP = findSwing4hTP(candles4h, entryMid, stopLoss, isBullReversal);
          if (structTP !== null) takeProfit = structTP;
        }

        const entryZone: [number, number] = isBullReversal
          ? [entryMid - avgAtr5m * 0.1, entryMid + avgAtr5m * 0.2]
          : [entryMid - avgAtr5m * 0.2, entryMid + avgAtr5m * 0.1];

        // ── Scoring ──────────────────────────────────────────────────
        const components = this.zeroComponents();

        // HTF: SWING uses 4h structural EMA analysis; others use 15m EMA direction
        if (tradeType === 'SWING') {
          const emaInfo = swingEmaScore(candles4h, entryMid, isBullReversal);
          components.htfAlignment = emaInfo.htfScore;
        } else {
          const ema20 = cachedEma(candles15m, 20);
          const ema50 = cachedEma(candles15m, 50);
          const n = candles15m.length - 1;
          const htfAligned =
            (isBullReversal && ema20[n] > ema50[n]) ||
            (!isBullReversal && ema20[n] < ema50[n]);
          components.htfAlignment = htfAligned ? 16 : 10;
        }

        // Setup quality: strong wick is key
        components.setupQuality = Math.min(20, Math.round(wickRatio * 8 + 8));

        // Momentum: confirmation candle
        const confBodySize = Math.abs(lastCandle5m.close - lastCandle5m.open);
        components.momentum = Math.min(15, Math.round((confBodySize / avgAtr5m) * 12));

        // Volatility
        const atrRatio = lastAtr5m / avgAtr5m;
        components.volatilityQuality = atrRatio < 2.0 ? 8 : 4;

        // Regime fit: RANGE is ideal; counter-trend trades in trending markets get penalised.
        // A counter-trend trade has higher failure risk when HTF momentum is intact,
        // so we knock 4 points off the regime score as a systematic handicap.
        if (regime === 'RANGE') {
          components.regimeFit = 10;
        } else if (isCounterTrend) {
          components.regimeFit = 3; // significant penalty — still tradeable but must score elsewhere
        } else {
          components.regimeFit = 6; // with-trend sweep in a trending regime
        }

        // Volume at sweep
        const avgVol15m = candles15m.slice(-20).reduce((s: number, cv: any) => s + cv.volume, 0) / 20;
        components.liquidity = c.volume > avgVol15m * 1.3 ? 10 : 6;

        // Slippage
        components.slippageRisk = 4;

        // Session
        components.sessionQuality = sessionQualityScore();

        // Recent performance
        components.recentPerformance = 3;

        const score = this.totalScore(components);
        const tier: ScoreTier =
          score >= 80 ? 'ELITE' : score >= 60 ? 'STRONG' : score >= 40 ? 'MEDIUM' : 'NO_TRADE';

        if (tier === 'NO_TRADE') continue;

        // Asia session gate: scalp trades have tight stops — avoid low-liquidity hours
        if (tradeType === 'SCALP' && sessionQualityScore() <= 2) continue;

        return {
          id: uuidv4(),
          strategy: this.name,
          asset: 'BTC/USDT', // placeholder — overwritten by caller
          direction: isBullReversal ? 'LONG' : 'SHORT',
          tradeType,
          entryZone,
          stopLoss,
          takeProfit,
          components,
          score,
          tier,
          regime,
          timestamp: Date.now(),
          notes: `Sweep@${swingLevel.toFixed(2)}, WickRatio=${wickRatio.toFixed(1)}, SL=${(stopPct * 100).toFixed(2)}% [${tradeType}]${isCounterTrend ? ' [counter-trend]' : ''}`,
        };
      }
    }
    return null;
  }
}
