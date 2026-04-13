import { v4 as uuidv4 } from 'uuid';
import { BaseStrategy } from './base';
import {
  bollinger,
  bollingerWidthMin,
  sessionQualityScore,
  isVolumeSpike,
} from '../indicators/indicators';
import { cachedEma, cachedAtr, cachedAtrAverage } from '../indicators/cache';
import { findSwing4hTP, swingEmaScore } from './swingHelpers';
import type { StrategySignal, MultiTimeframeData, Regime, ScoreTier, TradeType } from '../types';


/**
 * Volatility Expansion Strategy
 *
 * Logic:
 *  - Identify Bollinger Band squeeze on 4h or 15m (width at ≤ 20-period low)
 *  - Entry: 15m close outside Bollinger bands + ATR expanding above 14-period avg
 *  - Direction: determined by last 10 candles' price trend on 4h
 *
 * Suitable for: LOW_VOL_COMPRESSION
 */
export class VolatilityExpansionStrategy extends BaseStrategy {
  readonly name = 'Volatility Expansion';
  readonly supportedRegimes: Regime[] = ['LOW_VOL_COMPRESSION'];

  analyze(data: MultiTimeframeData, regime: Regime): StrategySignal | null {
    if (!this.isRegimeSupported(regime)) return null;

    const candles4h = data['4h'];
    const candles15m = data['15m'];
    const candles5m = data['5m'];

    if (candles4h.length < 30 || candles15m.length < 30 || candles5m.length < 20) return null;

    const bb15m = bollinger(candles15m, 20, 2);
    const bb4h = bollinger(candles4h, 20, 2);
    const n15 = candles15m.length - 1;
    const n4h = candles4h.length - 1;

    // ── Confirm squeeze exists on 15m or 4h ────────────────────────────────
    const currentWidth15m = bb15m.width[n15];
    const minWidth15m = bollingerWidthMin(bb15m.width, 20);
    // Guard: Infinity means insufficient BB history — don't treat as squeeze
    const isSqueeze15m = !isNaN(currentWidth15m) && isFinite(minWidth15m) && currentWidth15m <= minWidth15m * 1.1;

    const currentWidth4h = bb4h.width[n4h];
    const minWidth4h = bollingerWidthMin(bb4h.width, 20);
    const isSqueeze4h = !isNaN(currentWidth4h) && isFinite(minWidth4h) && currentWidth4h <= minWidth4h * 1.1;

    if (!isSqueeze15m && !isSqueeze4h) return null;

    // ── Detect expansion: close outside Bollinger on 15m ──────────────────
    const lastCandle15m = candles15m[n15];
    const upperBand15m = bb15m.upper[n15];
    const lowerBand15m = bb15m.lower[n15];

    const breakUp = lastCandle15m.close > upperBand15m;
    const breakDown = lastCandle15m.close < lowerBand15m;

    if (!breakUp && !breakDown) return null;

    // ── ATR must be expanding ─────────────────────────────────────────────
    const lastAtr15m = cachedAtr(candles15m, 14)[n15];
    const avgAtr15m  = cachedAtrAverage(candles15m, 14);
    if (lastAtr15m <= avgAtr15m * 1.1) return null; // must be genuinely expanding (>10% above avg)

    const lastAtr5m = cachedAtr(candles5m, 14)[candles5m.length - 1];
    const avgAtr5m  = cachedAtrAverage(candles5m, 14);
    const lastAtr4h = cachedAtr(candles4h, 14)[n4h];

    // ── Direction: 4h trend from last 10 candles ────────────────────────
    const last10_4h = candles4h.slice(-10);
    const trendPrice = last10_4h[last10_4h.length - 1].close - last10_4h[0].close;
    const isLong = breakUp || (trendPrice > 0 && !breakDown);

    // Reconcile: if break direction and trend disagree, no trade
    if (breakUp && trendPrice < 0) return null;
    if (breakDown && trendPrice > 0) return null;

    // ── Volume confirmation ────────────────────────────────────────────────
    const hasVolumeSpike = isVolumeSpike(candles15m.slice(-20), 1.4);
    if (!hasVolumeSpike) return null;

    // ── Build signal ──────────────────────────────────────────────────────
    const n5 = candles5m.length - 1;
    const lastCandle5m = candles5m[n5];
    const entryMid = lastCandle5m.close;

    // SL: try three modes — SCALP (1m) → SWING (4h BB) → HYBRID (15m BB default)
    const candles1m = data['1m'];
    // HYBRID default: back inside the 15m Bollinger band with 0.5×ATR buffer
    let stopLoss: number = isLong
      ? lowerBand15m - lastAtr15m * 0.5
      : upperBand15m + lastAtr15m * 0.5;
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

    // SWING: when the squeeze was on 4h, use the 4h BB opposite band as the stop
    if (!stopModeSet && isSqueeze4h) {
      const upperBand4h = bb4h.upper[n4h];
      const lowerBand4h = bb4h.lower[n4h];
      const swingStop4h = isLong
        ? lowerBand4h - lastAtr4h * 0.5
        : upperBand4h + lastAtr4h * 0.5;
      const swingPct4h = Math.abs(entryMid - swingStop4h) / entryMid;
      if (swingPct4h > 0.015 && swingPct4h < 0.05) {
        stopLoss = swingStop4h;
        stopModeSet = true;
      }
    }
    // stopModeSet unused below — stopLoss is always a number from this point

    const stopDistance = Math.abs(entryMid - stopLoss);
    // TP: trade-type-aware R:R target; SWING upgrades to structural 4h level.
    const stopPct = entryMid > 0 ? stopDistance / entryMid : 0;
    const tradeType: TradeType = stopPct < 0.003 ? 'SCALP' : stopPct < 0.015 ? 'HYBRID' : 'SWING';
    const rrMultiplier = tradeType === 'SCALP' ? 4.0 : tradeType === 'HYBRID' ? 3.0 : 2.5;
    let takeProfit = isLong ? entryMid + stopDistance * rrMultiplier : entryMid - stopDistance * rrMultiplier;
    if (tradeType === 'SWING') {
      const structTP = findSwing4hTP(candles4h, entryMid, stopLoss, isLong);
      if (structTP !== null) takeProfit = structTP;
    }

    const entryZone: [number, number] = [
      entryMid - lastAtr5m * 0.15,
      entryMid + lastAtr5m * 0.15,
    ];

    // ── Scoring ───────────────────────────────────────────────────────────
    const components = this.zeroComponents();

    // HTF alignment: SWING uses full 4h EMA structure analysis
    if (tradeType === 'SWING') {
      const emaInfo = swingEmaScore(candles4h, entryMid, isLong);
      components.htfAlignment = emaInfo.htfScore;
    } else {
      const ema20_4h = cachedEma(candles4h, 20);
      const ema50_4h = cachedEma(candles4h, 50);
      const htfAligned =
        (isLong && ema20_4h[n4h] > ema50_4h[n4h]) ||
        (!isLong && ema20_4h[n4h] < ema50_4h[n4h]);
      components.htfAlignment = htfAligned ? 18 : 10;
    }

    // Setup quality: how long was the squeeze?
    const squezeDuration = this.measureSqueezeDuration(bb15m.width, 20);
    components.setupQuality = Math.min(20, Math.round(squezeDuration * 2 + 6));

    // Momentum
    const expansionRatio = lastAtr15m / avgAtr15m;
    components.momentum = Math.min(15, Math.round(expansionRatio * 7));

    // Volatility quality: expanding is good for this strategy
    components.volatilityQuality = expansionRatio >= 1.1 ? 9 : 5;

    // Regime fit: perfect
    components.regimeFit = 10;

    // Volume
    components.liquidity = hasVolumeSpike ? 10 : 5;

    // Slippage
    components.slippageRisk = 4;

    // Session
    components.sessionQuality = sessionQualityScore();

    // Recent performance
    components.recentPerformance = 3;

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
      entryZone,
      stopLoss,
      takeProfit,
      components,
      score,
      tier,
      regime,
      timestamp: Date.now(),
      notes: `Squeeze${isSqueeze4h ? '+4h' : ''}, ATRx=${(lastAtr15m / avgAtr15m).toFixed(2)}, SL=${(stopPct * 100).toFixed(2)}% [${tradeType}]`,
    };
  }

  private measureSqueezeDuration(widths: number[], maxLookback: number): number {
    const recent = widths.filter((v) => !isNaN(v)).slice(-maxLookback);
    if (recent.length === 0) return 0;
    const minWidth = Math.min(...recent);
    let count = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i] <= minWidth * 1.2) count++;
      else break;
    }
    return count;
  }
}
