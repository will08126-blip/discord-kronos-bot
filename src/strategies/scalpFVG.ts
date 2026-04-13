/**
 * ScalpFVG Strategy — Multi-Confluence Scalp
 *
 * Entry requires ALL of these layers (paper trading auto-enters everything ≥ 60 pts):
 *
 *   LAYER 1 — FVG ZONE  (Fair Value Gap on 1m or 5m)
 *     An unfilled imbalance near current price confirms supply/demand imbalance.
 *
 *   LAYER 2 — MACD MOMENTUM  (fast 5,13,3 on 5m)
 *     MACD crossover or recent cross (within 3 bars) confirms direction.
 *
 *   LAYER 3 — EMA TREND FILTER  (8/21 EMA on 5m + 15m)
 *     At least one TF must agree with direction; both agreeing = higher score.
 *
 *   LAYER 4 — VWAP FILTER  (session VWAP on 5m)
 *     Price above VWAP = long bias; price below VWAP = short bias.
 *     Eliminates counter-VWAP trades that tend to chop.
 *
 *   LAYER 5 — BOLLINGER BAND CONTEXT  (20-period 2σ on 5m)
 *     BB squeeze before entry = compression about to release (high probability).
 *     Price at band + FVG = highest quality entry zone.
 *
 *   LAYER 6 — VOLUME CONFIRMATION
 *     Volume spike or above-average volume required.
 *
 * Score gate: ≥ 60 / 100 for paper trading.
 * High-quality scalps (HYBRID type) still post to #bot-signals when score ≥ 65.
 *
 * Stop: beyond FVG zone + 0.5×ATR(1m).
 * Target: 4×R (SCALP) or 3×R (HYBRID).
 * Leverage: managed by scalp params file (adaptive).
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseStrategy } from './base';
import {
  cachedAtr, cachedRsi, cachedMacd, cachedFVGs, cachedEmaQuickTrend, cachedVwap, cachedBollinger,
} from '../indicators/cache';
import {
  isVolumeSpike, sessionQualityScore, volumeAverage, isPriceInFVG,
} from '../indicators/indicators';
import type { StrategySignal, MultiTimeframeData, Regime, ScoreTier, TradeType } from '../types';

export class ScalpFVGStrategy extends BaseStrategy {
  readonly name = 'Scalp FVG';
  readonly supportedRegimes: Regime[] = [
    'TREND_UP', 'TREND_DOWN', 'RANGE', 'VOL_EXPANSION', 'LOW_VOL_COMPRESSION',
  ];

  analyze(data: MultiTimeframeData, regime: Regime): StrategySignal | null {
    if (!this.isRegimeSupported(regime)) return null;

    const candles1m  = data['1m'];
    const candles5m  = data['5m'];
    const candles15m = data['15m'];

    if (!candles1m  || candles1m.length  < 30) return null;
    if (!candles5m  || candles5m.length  < 30) return null;
    if (!candles15m || candles15m.length < 20) return null;

    // ── Time-based filters ────────────────────────────────────────────────────
    const nowUtc      = new Date();
    const hourUtc     = nowUtc.getUTCHours();
    const dayOfWeek   = nowUtc.getUTCDay(); // 0=Sun, 6=Sat
    const isWeekend   = dayOfWeek === 0 || dayOfWeek === 6;

    // Skip weekends entirely (low liquidity, noisy FVGs)
    if (isWeekend) return null;

    // Hard blacklist: 12:00–13:00 UTC = London lunch.
    // First live session showed 7 trades, 0 wins in this window.
    // Low volume + directionless chop = no edge for FVG scalps.
    if (hourUtc === 12) return null;
    // Only trade during London and NY sessions (8:00-16:00 UTC)
    if (hourUtc < 8 || hourUtc >= 16) return null;

    // Weekends are skipped entirely (low liquidity, noisy FVGs).
    const weekendScorePenalty = 0;

    const n1 = candles1m.length - 1;
    const n5 = candles5m.length  - 1;
    const currentPrice = candles1m[n1].close;

    // ── Layer 1: Fair Value Gap ───────────────────────────────────────────────
    const fvgs1m = cachedFVGs(candles1m, 8);
    const fvgs5m = cachedFVGs(candles5m, 5);

    const PROXIMITY_PCT = 0.015;
    const nearBull1m = fvgs1m.filter((z) => z.type === 'BULLISH' && Math.abs(z.midpoint - currentPrice) / currentPrice <= PROXIMITY_PCT);
    const nearBear1m = fvgs1m.filter((z) => z.type === 'BEARISH' && Math.abs(z.midpoint - currentPrice) / currentPrice <= PROXIMITY_PCT);
    const nearBull5m = fvgs5m.filter((z) => z.type === 'BULLISH' && Math.abs(z.midpoint - currentPrice) / currentPrice <= PROXIMITY_PCT);
    const nearBear5m = fvgs5m.filter((z) => z.type === 'BEARISH' && Math.abs(z.midpoint - currentPrice) / currentPrice <= PROXIMITY_PCT);

    const bestBullFVG = [...nearBull1m, ...nearBull5m]
      .sort((a, b) => Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice))[0];
    const bestBearFVG = [...nearBear1m, ...nearBear5m]
      .sort((a, b) => Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice))[0];

    if (!bestBullFVG && !bestBearFVG) return null;

    // ── Layer 2: MACD crossover on 5m (fast scalp params) ────────────────────
    const macd5m     = cachedMacd(candles5m, 5, 13, 3);
    const macdLine   = macd5m.macdLine;
    const signalLine = macd5m.signalLine;

    const macdNow  = macdLine[n5];
    const macdPrev = macdLine[n5 - 1];
    const sigNow   = signalLine[n5];
    const sigPrev  = signalLine[n5 - 1];

    if (isNaN(macdNow) || isNaN(macdPrev) || isNaN(sigNow) || isNaN(sigPrev)) return null;

    const bullishCross   = macdPrev <= sigPrev && macdNow > sigNow;
    const bearishCross   = macdPrev >= sigPrev && macdNow < sigNow;

    // Recent cross within 3 bars
    const recentBullCross = (() => {
      for (let i = 1; i <= 3; i++) {
        const mi = macdLine[n5 - i]; const si = signalLine[n5 - i];
        const mp = macdLine[n5 - i - 1]; const sp = signalLine[n5 - i - 1];
        if (!isNaN(mi) && !isNaN(si) && !isNaN(mp) && !isNaN(sp) && mp <= sp && mi > si) return true;
      }
      return false;
    })();
    const recentBearCross = (() => {
      for (let i = 1; i <= 3; i++) {
        const mi = macdLine[n5 - i]; const si = signalLine[n5 - i];
        const mp = macdLine[n5 - i - 1]; const sp = signalLine[n5 - i - 1];
        if (!isNaN(mi) && !isNaN(si) && !isNaN(mp) && !isNaN(sp) && mp >= sp && mi < si) return true;
      }
      return false;
    })();

    const macdBull = bullishCross || recentBullCross;
    const macdBear = bearishCross || recentBearCross;

    // ── Layer 3: MTF EMA 8/21 trend filter ───────────────────────────────────
    const trend5m  = cachedEmaQuickTrend(candles5m,  8, 21);
    const trend15m = cachedEmaQuickTrend(candles15m, 8, 21);

    const bullTrend = trend5m === 'UP'   || trend15m === 'UP';
    const bearTrend = trend5m === 'DOWN' || trend15m === 'DOWN';
    const bothBull  = trend5m === 'UP'   && trend15m === 'UP';
    const bothBear  = trend5m === 'DOWN' && trend15m === 'DOWN';

    // ── Layer 4: VWAP filter ──────────────────────────────────────────────────
    const vwapVals5m   = cachedVwap(candles5m);
    const vwapNow      = vwapVals5m[n5];
    const vwapBullish  = !isNaN(vwapNow) && currentPrice > vwapNow;
    const vwapBearish  = !isNaN(vwapNow) && currentPrice < vwapNow;
    const vwapConflict = isNaN(vwapNow); // unknown — treat as neutral, not blocking

    // ── Layer 5: Bollinger Band context on 5m ─────────────────────────────────
    const bb5m       = cachedBollinger(candles5m, 20, 2);
    const bbUpper    = bb5m.upper[n5];
    const bbLower    = bb5m.lower[n5];
    const bbWidth    = bb5m.width[n5];
    const recentBBWidths = bb5m.width.slice(-20).filter((w) => !isNaN(w));
    const minBBWidth = recentBBWidths.length > 0 ? Math.min(...recentBBWidths) : Infinity;
    const bbSqueeze  = !isNaN(bbWidth) && bbWidth <= minBBWidth * 1.05;
    const bbRange    = (!isNaN(bbUpper) && !isNaN(bbLower)) ? bbUpper - bbLower : 0;
    const touchZone  = bbRange * 0.08;
    const atBBLower  = !isNaN(bbLower) && currentPrice <= bbLower + touchZone;
    const atBBUpper  = !isNaN(bbUpper) && currentPrice >= bbUpper - touchZone;

    // ── Layer 6: Volume ───────────────────────────────────────────────────────
    const volSpike  = isVolumeSpike(candles5m.slice(-20), 1.2);
    const volAvg5m  = volumeAverage(candles5m, 20);
    const lastVol5m = candles5m[n5].volume;
    const volRatio  = volAvg5m > 0 ? lastVol5m / volAvg5m : 1;
    const goodVol   = volRatio >= 0.9; // at least 90% of average (crypto markets always active)

    // ── Direction resolution ──────────────────────────────────────────────────
    let isLong: boolean;
    let fvgZone: typeof bestBullFVG;

    const longOk  = Boolean(bestBullFVG && macdBull && bothBull && (vwapBullish || vwapConflict));
    const shortOk = Boolean(bestBearFVG && macdBear && bothBear && (vwapBearish || vwapConflict));

    if (longOk && !shortOk) {
      isLong  = true;
      fvgZone = bestBullFVG;
    } else if (shortOk && !longOk) {
      isLong  = false;
      fvgZone = bestBearFVG;
    } else if (longOk && shortOk) {
      // Conflicting signals — prefer the direction with the nearest FVG
      const dBull = Math.abs((bestBullFVG?.midpoint ?? 0) - currentPrice);
      const dBear = Math.abs((bestBearFVG?.midpoint ?? 0) - currentPrice);
      isLong  = dBull <= dBear;
      fvgZone = isLong ? bestBullFVG : bestBearFVG;
    } else {
      return null; // no valid direction
    }

    if (!fvgZone) return null;

    // Price must be inside the FVG zone
    const inZone    = isPriceInFVG(currentPrice, fvgZone, 0.003);
    if (!inZone) return null;

    // ── RSI overextension guard ───────────────────────────────────────────────
    const rsi5m = cachedRsi(candles5m, 14)[n5];
    if (!isNaN(rsi5m)) {
      if (isLong  && rsi5m > 80) return null; // overbought — skip
      if (!isLong && rsi5m < 20) return null; // oversold   — skip
    }

    // ── Stop Loss & Take Profit ───────────────────────────────────────────────
    const atr1m = cachedAtr(candles1m, 14)[n1];
    if (isNaN(atr1m) || atr1m <= 0) return null;

    const stopLoss = isLong
      ? fvgZone.gapLow  - atr1m * 1.0
      : fvgZone.gapHigh + atr1m * 1.0;

    const stopDist = Math.abs(currentPrice - stopLoss);
    if (stopDist <= 0) return null;

    const stopPct: number   = stopDist / currentPrice;
    const tradeType: TradeType = stopPct < 0.003 ? 'SCALP' : 'HYBRID';
    const rrMult = tradeType === 'SCALP' ? 4.0 : 3.0;

    const takeProfit = isLong
      ? currentPrice + stopDist * rrMult
      : currentPrice - stopDist * rrMult;

    const entryLow  = currentPrice * 0.9998;
    const entryHigh = currentPrice * 1.0002;

    // ── Scoring ───────────────────────────────────────────────────────────────
    const components = this.zeroComponents();

    // HTF alignment (0–20): EMA agreement across timeframes
    components.htfAlignment = bothBull || bothBear ? 20 : 12;

    // Setup quality (0–20): FVG quality + price inside zone + BB context
    const fvgScore    = Math.min(10, Math.round(fvgZone.strength * 10000));
    const bbBonus     = bbSqueeze ? 5 : (atBBLower || atBBUpper) ? 3 : 0;
    components.setupQuality = Math.min(20, fvgScore + (inZone ? 8 : 4) + bbBonus - (inZone ? 2 : 0)); // fvgScore + zone + bb

    // Momentum (0–15): MACD freshness + histogram
    const hist     = macd5m.histogram[n5];
    const histPrev = macd5m.histogram[n5 - 1];
    const histGrowing = isLong
      ? !isNaN(hist) && !isNaN(histPrev) && hist > histPrev
      : !isNaN(hist) && !isNaN(histPrev) && hist < histPrev;
    components.momentum = (bullishCross || bearishCross) ? 15 : histGrowing ? 10 : 6;

    // Volatility quality (0–10): BB context + ATR health
    const atr5m     = cachedAtr(candles5m, 14)[n5];
    const atrRatio  = atr5m / (candles5m[n5].close * 0.005);
    const atrScore  = Math.min(7, Math.round(7 - Math.abs(atrRatio - 1) * 2));
    components.volatilityQuality = Math.min(10, atrScore + (bbSqueeze ? 3 : 0));

    // Regime fit (0–10)
    const trendingRegime = regime === 'TREND_UP' || regime === 'TREND_DOWN' || regime === 'VOL_EXPANSION';
    components.regimeFit = trendingRegime ? 10 : 6;

    // Liquidity (0–10): VWAP alignment + volume
    const vwapScore = vwapConflict ? 5 : (isLong ? (vwapBullish ? 4 : 1) : (vwapBearish ? 4 : 1));
    components.liquidity = Math.min(10, Math.round(volRatio * 4) + vwapScore + (volSpike ? 2 : 0));

    // Slippage (0–5): tight 1m spread
    const spread1m = candles1m[n1].high - candles1m[n1].low;
    components.slippageRisk = spread1m < atr1m * 1.5 ? 5 : 3;

    // Session (0–5)
    components.sessionQuality = sessionQualityScore();

    // Recent performance baseline
    components.recentPerformance = 3;

    const score = this.totalScore(components);

    // Weekends are skipped entirely, so no penalty needed.
    const effectiveScore = score;

    // Scalp gate: 60 minimum; hybrids ≥ 70 posted to #bot-signals
    const tier: ScoreTier =
      effectiveScore >= 85 ? 'ELITE' :
      effectiveScore >= 70 ? 'STRONG' :
      effectiveScore >= 60 ? 'MEDIUM' :
      'NO_TRADE';

    if (tier === 'NO_TRADE') return null;
    if (!goodVol && tier === 'MEDIUM') return null; // low-volume MEDIUMs → skip

    // ── Notes ─────────────────────────────────────────────────────────────────
    const macdStr    = (bullishCross || bearishCross) ? 'fresh cross' : 'recent cross';
    const fvgSrc     = nearBull1m.length > 0 || nearBear1m.length > 0 ? '1m' : '5m';
    const vwapStr    = vwapConflict ? '' : ` VWAP:${vwapBullish ? '↑' : '↓'}`;
    const bbStr      = bbSqueeze ? ' BB⚡Squeeze' : (atBBLower || atBBUpper) ? ' BB Band' : '';
    const rsiStr     = !isNaN(rsi5m) ? ` RSI=${rsi5m.toFixed(0)}` : '';
    const trendStr   = `5m:${trend5m} 15m:${trend15m}`;
    const notes = `FVG(${fvgSrc}) zone=$${fvgZone.gapLow.toFixed(4)}–$${fvgZone.gapHigh.toFixed(4)} | MACD ${macdStr} ${trendStr}${vwapStr}${bbStr}${rsiStr} [${tradeType}]`;

    return {
      id:        uuidv4(),
      strategy:  this.name,
      asset:     data.asset,
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
      notes,
    };
  }
}
