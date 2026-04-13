import { v4 as uuidv4 } from 'uuid';
import { BaseStrategy } from './base';
import {
  isBullishEngulfing,
  isBearishEngulfing,
  isBullishPin,
  isBearishPin,
  isVolumeSpike,
  sessionQualityScore,
} from '../indicators/indicators';
import { cachedEma, cachedRsi, cachedAtr, cachedAtrAverage } from '../indicators/cache';
import {
  findSwing4hStop,
  findSwing4hTP,
  swingRsiCheck,
  swingEmaScore,
} from './swingHelpers';

import type { StrategySignal, MultiTimeframeData, Regime, ScoreTier, TradeType } from '../types';

/**
 * Trend Pullback Strategy
 *
 * Logic:
 *  - 4h: EMA alignment confirms trend direction (20 > 50 > 200 for long)
 *  - 15m: RSI has pulled back to 40-55 range (long) / 45-60 (short), price near EMA20
 *  - 5m:  Bullish engulfing or pin bar at EMA20 confirms reversal
 *
 * Suitable for: TREND_UP, TREND_DOWN
 */
export class TrendPullbackStrategy extends BaseStrategy {
  readonly name = 'Trend Pullback';
  readonly supportedRegimes: Regime[] = ['TREND_UP', 'TREND_DOWN'];

  analyze(data: MultiTimeframeData, regime: Regime): StrategySignal | null {
    if (!this.isRegimeSupported(regime)) return null;

    const isLong = regime === 'TREND_UP';
    const candles4h = data['4h'];
    const candles15m = data['15m'];
    const candles5m = data['5m'];

    if (candles4h.length < 50 || candles15m.length < 30 || candles5m.length < 20) return null;

    // ── 4H: EMA alignment ────────────────────────────────────────────────────
    const ema20_4h = cachedEma(candles4h, 20);
    const ema50_4h = cachedEma(candles4h, 50);
    const ema200_4h = cachedEma(candles4h, 200);
    const n4h = candles4h.length - 1;

    const htfUpAligned =
      ema20_4h[n4h] > ema50_4h[n4h] && ema50_4h[n4h] > ema200_4h[n4h];
    const htfDownAligned =
      ema20_4h[n4h] < ema50_4h[n4h] && ema50_4h[n4h] < ema200_4h[n4h];
    const htfAligned = isLong ? htfUpAligned : htfDownAligned;

    if (!htfAligned) return null;

    // ── 15M: RSI pullback + price near EMA20 ─────────────────────────────────
    const ema20_15m = cachedEma(candles15m, 20);
    const rsi_15m = cachedRsi(candles15m, 14);
    const n15 = candles15m.length - 1;

    const lastClose15 = candles15m[n15].close;
    const lastEma20_15 = ema20_15m[n15];
    const lastRsi15 = rsi_15m[n15];

    const priceNearEma = Math.abs(lastClose15 - lastEma20_15) / lastEma20_15 < 0.005; // within 0.5%

    // RSI ranges are mirrored around 50 so LONG and SHORT conditions are equally selective.
    // LONG:  38–58  (pulled back from overbought, not yet oversold)
    // SHORT: 42–62  (bounced from oversold, not yet overbought) — mirror of LONG around 50
    const rsiPulledBack = isLong
      ? lastRsi15 >= 38 && lastRsi15 <= 58
      : lastRsi15 >= 42 && lastRsi15 <= 62;

    if (!rsiPulledBack || !priceNearEma) return null;

    // ── 5M: Entry confirmation ─────────────────────────────────────────────
    const ema20_5m = cachedEma(candles5m, 20);
    const n5 = candles5m.length - 1;
    const lastCandle5m = candles5m[n5];
    const prevCandle5m = candles5m[n5 - 1];
    const lastEma20_5m = ema20_5m[n5];
    const lastAtr5m = cachedAtr(candles5m, 14)[n5];
    const avgAtr5m = cachedAtrAverage(candles5m, 14);
    const lastAtr4h = cachedAtr(candles4h, 14)[n4h];

    const confirmBull =
      isBullishEngulfing(candles5m.slice(-2)) ||
      isBullishPin(lastCandle5m);
    const confirmBear =
      isBearishEngulfing(candles5m.slice(-2)) ||
      isBearishPin(lastCandle5m);
    const confirmed = isLong ? confirmBull : confirmBear;

    if (!confirmed) return null;

    // Price should be near 5m EMA20
    const priceNearEma5m = Math.abs(lastCandle5m.close - lastEma20_5m) / lastEma20_5m < 0.008;
    if (!priceNearEma5m) return null;

    // ── Build signal ──────────────────────────────────────────────────────────
    const entryLow = isLong
      ? Math.min(lastCandle5m.close, lastEma20_5m)
      : Math.min(lastCandle5m.close, lastEma20_5m) - lastAtr5m * 0.1;
    const entryHigh = isLong
      ? Math.max(lastCandle5m.close, lastEma20_5m) + lastAtr5m * 0.1
      : Math.max(lastCandle5m.close, lastEma20_5m);

    const entryMid = (entryLow + entryHigh) / 2;

    // SL: try three modes — SCALP (1m) → SWING (4h) → HYBRID (5m default)
    const candles1m = data['1m'];
    // HYBRID default: 5m swing low/high of last 5 candles + 1.0×ATR5m
    const hybridCandles = candles5m.slice(-5);
    const hybridLow  = Math.min(...hybridCandles.map((c) => c.low));
    const hybridHigh = Math.max(...hybridCandles.map((c) => c.high));
    let stopLoss: number = isLong ? hybridLow - lastAtr5m * 1.0 : hybridHigh + lastAtr5m * 1.0;
    let stopModeSet = false;

    // SCALP: stop behind 3-candle 1m swing + 0.2×ATR1m
    if (!stopModeSet && candles1m && candles1m.length >= 5) {
      const n1 = candles1m.length - 1;
      const lastAtr1m = cachedAtr(candles1m, 14)[n1];
      const lastCandle1m = candles1m[n1];
      const recent1m = candles1m.slice(-3);
      const scalp1mLow  = Math.min(...recent1m.map((c) => c.low));
      const scalp1mHigh = Math.max(...recent1m.map((c) => c.high));
      const scalpStop = isLong ? scalp1mLow - lastAtr1m * 0.2 : scalp1mHigh + lastAtr1m * 0.2;
      const scalpPct  = Math.abs(entryMid - scalpStop) / entryMid;
      const body1m    = Math.abs(lastCandle1m.close - lastCandle1m.open);
      if (scalpPct < 0.003 && body1m > lastAtr1m * 0.3) {
        stopLoss = scalpStop;
        stopModeSet = true;
      }
    }

    // SWING: structural 4h stop from real swing-point analysis (pro-grade placement)
    if (!stopModeSet) {
      const swingStop = findSwing4hStop(candles4h, entryMid, isLong, lastAtr4h);
      if (swingStop !== null) {
        const rsiGate = swingRsiCheck(candles4h, isLong);
        if (rsiGate.favorable) {
          stopLoss = swingStop;
          stopModeSet = true;
        }
      }
    }
    // stopModeSet unused below — stopLoss is always a number from this point

    // TP: trade-type-aware R:R target.
    //   SCALP  (SL < 0.3%):  4:1 R:R
    //   HYBRID (SL 0.3-1.5%): 3:1 R:R
    //   SWING  (SL > 1.5%):  structural 4h level or 2.5:1 R:R fallback
    const stopDistance = Math.abs(entryMid - stopLoss);
    const stopPct = entryMid > 0 ? stopDistance / entryMid : 0;
    const tradeType: TradeType = stopPct < 0.003 ? 'SCALP' : stopPct < 0.015 ? 'HYBRID' : 'SWING';
    const rrMultiplier = tradeType === 'SCALP' ? 4.0 : tradeType === 'HYBRID' ? 3.0 : 2.5;
    let takeProfit = isLong ? entryMid + stopDistance * rrMultiplier : entryMid - stopDistance * rrMultiplier;

    // SWING: replace fixed R:R TP with next structural 4h swing level when available
    if (tradeType === 'SWING') {
      const structTP = findSwing4hTP(candles4h, entryMid, stopLoss, isLong);
      if (structTP !== null) takeProfit = structTP;
    }

    // ── Scoring ───────────────────────────────────────────────────────────────
    const components = this.zeroComponents();

    // HTF alignment (0-20)
    // SWING: use full 4h EMA structure analysis; SCALP/HYBRID: EMA spread proximity
    if (tradeType === 'SWING') {
      const emaInfo = swingEmaScore(candles4h, entryMid, isLong);
      components.htfAlignment = emaInfo.htfScore;
    } else {
      const ema20Distance = Math.abs(ema20_4h[n4h] - ema50_4h[n4h]) / ema50_4h[n4h];
      components.htfAlignment = Math.min(20, Math.round(10 + ema20Distance * 1000));
    }

    // Setup quality (0-20): clean pullback depth
    const rsiFromExtreme = isLong
      ? Math.max(0, lastRsi15 - 30) / 30  // 30→60 → 0→1
      : Math.max(0, 70 - lastRsi15) / 30;
    components.setupQuality = Math.min(20, Math.round(rsiFromExtreme * 20));
    // SWING bonus when entry is at 4h dynamic support (EMA20/EMA50)
    if (tradeType === 'SWING') {
      const emaInfo = swingEmaScore(candles4h, entryMid, isLong);
      if (emaInfo.nearKeyEma) components.setupQuality = Math.min(20, components.setupQuality + 3);
    }

    // Momentum: confirmation candle size vs ATR
    const bodySize = Math.abs(lastCandle5m.close - lastCandle5m.open);
    components.momentum = Math.min(15, Math.round((bodySize / avgAtr5m) * 10));

    // Volatility quality (0-10)
    // SWING: 4h RSI score reflects "room to run" on the higher timeframe
    // SCALP/HYBRID: ATR ratio (not too volatile for the timeframe)
    if (tradeType === 'SWING') {
      components.volatilityQuality = swingRsiCheck(candles4h, isLong).rsiScore;
    } else {
      const atrRatio = lastAtr5m / avgAtr5m;
      components.volatilityQuality = atrRatio < 2.0 ? Math.min(10, Math.round((2.0 - atrRatio) * 10)) : 0;
    }

    // Regime fit: perfect match
    components.regimeFit = 10;

    // Liquidity (0-10): volume on confirmation candle
    components.liquidity = isVolumeSpike(candles5m.slice(-20), 1.2) ? 10 : 5;

    // Slippage risk (0-5)
    const spread = lastCandle5m.high - lastCandle5m.low;
    components.slippageRisk = spread < lastAtr5m * 1.5 ? 5 : 2;

    // Session quality (0-5)
    components.sessionQuality = sessionQualityScore();

    // Recent performance: will be set by voting engine via adaptation weights
    components.recentPerformance = 3; // default neutral

    const score = this.totalScore(components);
    const tier: ScoreTier =
      score >= 80 ? 'ELITE' : score >= 60 ? 'STRONG' : score >= 40 ? 'MEDIUM' : 'NO_TRADE';

    if (tier === 'NO_TRADE') return null;

    // Asia session gate: scalp trades have tight stops — avoid low-liquidity hours
    if (tradeType === 'SCALP' && sessionQualityScore() <= 2) return null;

    return {
      id: uuidv4(),
      strategy: this.name,
      asset: data.asset,
      direction: isLong ? 'LONG' : 'SHORT',
      tradeType,
      entryZone: [entryLow, entryHigh],
      stopLoss,
      takeProfit,
      components,
      score,
      tier,
      regime,
      timestamp: Date.now(),
      notes: `RSI15m=${lastRsi15.toFixed(1)}, SL=${(stopPct * 100).toFixed(2)}%${tradeType === 'SWING' ? ` RSI4h=${swingRsiCheck(candles4h, isLong).rsi4h.toFixed(0)}` : ''} [${tradeType}]`,
    };
  }
}
