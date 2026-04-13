/**
 * Professional Swing Trade Strategy — Confluence Stack Edition
 *
 * Signals are only generated when ALL of these layers align:
 *
 *   LAYER 1 — HTF BIAS  (Weekly + Daily + 4h market structure)
 *     Required: ≥ 2 of 3 higher timeframes agree on direction.
 *     Best case: all 3 aligned → max score.
 *
 *   LAYER 2 — EMA ZONE  (20 / 50 / 200 EMA on 4h and daily)
 *     Price approaching or touching a key EMA in the direction of bias.
 *     EMA stack order (20>50>200 bull / 20<50<200 bear) = trend health indicator.
 *     Dynamic zone: price within 0.5 ATR of the nearest EMA = "at value".
 *
 *   LAYER 3 — BOLLINGER BANDS  (20-period, 2σ on 4h)
 *     - Squeeze detected (width at 20-bar min) + price at band = compression ready to fire.
 *     - Price at lower band (long) / upper band (short) in a trending market = mean-reversion entry.
 *     - Band expansion post-squeeze = momentum confirmation.
 *
 *   LAYER 4 — MACD MOMENTUM  (12, 26, 9 on 4h — standard swing params)
 *     - MACD crossover OR zero-line cross = strongest signal.
 *     - Histogram inflection (turning from negative to positive) = early entry.
 *     - RSI bouncing 40–50 support (bull) or 50–60 resistance (bear).
 *
 *   LAYER 5 — ENTRY TRIGGER  (candlestick confirmation on 4h)
 *     - Bullish / Bearish Engulfing  (highest quality, 15 pts)
 *     - Pin Bar at EMA / BB level   (13 pts)
 *     - Displacement candle          (12 pts)
 *     - RSI divergence               (11 pts)
 *     - Liquidity sweep              (10 pts)
 *
 * Score gate: ≥ 65 / 100 to post to #bot-signals.
 * This intentionally produces fewer, higher-quality signals.
 *
 * Leverage: ELITE=10x, STRONG=8x, MEDIUM=5x (tier-based, no dynamic formula).
 * Hold time: 1–5 days.
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseStrategy } from './base';
import { analyseMarketStructure, findStructuralStopPoint, findStructuralTargets } from '../analysis/marketStructure';
import { cachedRsi, cachedAtr, cachedAtrAverage, cachedEma, cachedMacd } from '../indicators/cache';
import { bollinger, hasBullishDivergence, hasBearishDivergence, sessionQualityScore, isBullishEngulfing, isBearishEngulfing, isBullishPin, isBearishPin, volumeAverage } from '../indicators/indicators';
import { config } from '../config';
import type { StrategySignal, MultiTimeframeData, Regime, ScoreTier, SwingTrigger, SwingMeta, OHLCV } from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_RR_PRIMARY             = 2.5;    // minimum 2.5:1 R:R to qualify
const STOP_ATR_BUFFER            = 0.25;   // ATR multiplier added to structural stop
const MIN_STOP_PCT               = 0.003;  // 0.3% min stop (avoids noise-sized stops)
const MAX_STOP_PCT               = 0.06;   // 6% max stop (swing trades can breathe)
const EMA_TOUCH_ATR_MULT         = 0.5;    // price within 0.5 ATR of EMA = "at EMA"
const MIN_SCORE                  = 65;     // strict gate — quality over quantity
const DISPLACEMENT_BODY_ATR_MULT = 0.6;
const DISPLACEMENT_VOLUME_MULT   = 1.3;

// ─── Types ───────────────────────────────────────────────────────────────────

interface TriggerResult {
  type: SwingTrigger;
  quality: number;
  hasVolumeConfirmation: boolean;
  label: string;
}

interface EmaAnalysis {
  ema20: number;
  ema50: number;
  ema200: number;
  stackBullish: boolean;  // 20 > 50 > 200
  stackBearish: boolean;  // 20 < 50 < 200
  atEma20: boolean;
  atEma50: boolean;
  atEma200: boolean;
  nearestEmaLabel: string;
  score: number;          // 0–20
}

interface BbAnalysis {
  upper: number;
  middle: number;
  lower: number;
  width: number;
  atUpperBand: boolean;
  atLowerBand: boolean;
  isSqueeze: boolean;
  isExpanding: boolean;
  score: number;          // 0–10
  label: string;
}

interface MacdAnalysis {
  freshCross: boolean;
  zeroCross: boolean;
  histInflection: boolean;
  rsiBounce: boolean;
  score: number;          // 0–15
  label: string;
}

// ─── Strategy ────────────────────────────────────────────────────────────────

export class SwingStrategy extends BaseStrategy {
  readonly name = 'Swing';
  readonly supportedRegimes: Regime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE'];

  analyze(data: MultiTimeframeData, regime: Regime): StrategySignal | null {
    if (!this.isRegimeSupported(regime)) return null;

    const candles1w  = data['1w'];
    const candles1d  = data['1d'];
    const candles4h  = data['4h'];
    const candles15m = data['15m'];

    // Minimum candle requirements — Yahoo Finance assets on weekends may have fewer
    if (candles1w.length < 10)  return null;
    if (candles1d.length < 50)  return null;
    if (candles4h.length < 100) return null;
    if (candles15m.length < 20) return null;

    // ── Layer 1: HTF Bias ─────────────────────────────────────────────────────
    const bias = analyseMarketStructure(candles1w, candles1d, candles4h);
    if (bias.direction === null) return null;
    // Reject if all three HTF disagree (bias.confidence === 'LOW' with no clear direction)
    if (bias.confidence === 'LOW' && regime !== 'RANGE') return null;
    if (regime === 'TREND_UP'   && bias.direction !== 'LONG')  return null;
    if (regime === 'TREND_DOWN' && bias.direction !== 'SHORT') return null;

    const isLong = bias.direction === 'LONG';
    const c4h    = candles4h[candles4h.length - 1];
    const currentPrice = c4h.close;

    const atr4hVals  = cachedAtr(candles4h, 14);
    const atr4h      = atr4hVals[atr4hVals.length - 1];
    const avgAtr4h   = cachedAtrAverage(candles4h, 14);
    if (!atr4h || atr4h <= 0) return null;

    // ── Layer 2: EMA Zone Analysis ────────────────────────────────────────────
    const emaAnalysis = this.analyseEmaZone(candles4h, candles1d, currentPrice, isLong, atr4h);
    // EMA stack must be at least partially aligned — skip if completely opposed
    if (isLong  && emaAnalysis.ema20 < emaAnalysis.ema200 * 0.97) return null; // price deep below 200 EMA on 4h
    if (!isLong && emaAnalysis.ema20 > emaAnalysis.ema200 * 1.03) return null; // price deep above 200 EMA on 4h

    // ── Layer 3: Bollinger Band Analysis ─────────────────────────────────────
    const bbAnalysis = this.analyseBollingerBands(candles4h, currentPrice, isLong);

    // ── Layer 4: MACD Momentum ────────────────────────────────────────────────
    const macdAnalysis = this.analyseMacd(candles4h, candles1d, isLong);

    // ── Confluence gate: require at least 2 of 3 active layers ───────────────
    // (EMA at value, BB signal, MACD signal) — prevents low-quality signals
    const activeConfluences = [
      emaAnalysis.atEma20 || emaAnalysis.atEma50 || emaAnalysis.atEma200,
      bbAnalysis.atLowerBand || bbAnalysis.atUpperBand || bbAnalysis.isSqueeze,
      macdAnalysis.freshCross || macdAnalysis.zeroCross || macdAnalysis.histInflection || macdAnalysis.rsiBounce,
    ].filter(Boolean).length;

    if (activeConfluences < 2) return null;

    // ── Layer 5: Entry Trigger ────────────────────────────────────────────────
    const trigger = this.detectEntryTrigger(candles4h, candles15m, isLong, avgAtr4h);
    if (!trigger) return null;

    // ── Stop Loss ─────────────────────────────────────────────────────────────
    const stopPoint = findStructuralStopPoint(candles4h, '4h', currentPrice, isLong)
                   ?? findStructuralStopPoint(candles1d, '1d', currentPrice, isLong);
    if (!stopPoint) return null;

    const stopLoss = isLong
      ? stopPoint.price - atr4h * STOP_ATR_BUFFER
      : stopPoint.price + atr4h * STOP_ATR_BUFFER;

    const stopDist = Math.abs(currentPrice - stopLoss);
    const stopPct  = stopDist / currentPrice;
    if (stopPct < MIN_STOP_PCT || stopPct > MAX_STOP_PCT) return null;

    // ── Take Profit ───────────────────────────────────────────────────────────
    const targets = findStructuralTargets(candles1d, candles4h, currentPrice, stopLoss, isLong);
    if (targets.primary === null) {
      targets.primary = isLong
        ? currentPrice + stopDist * MIN_RR_PRIMARY
        : currentPrice - stopDist * MIN_RR_PRIMARY;
    }

    const rr = Math.abs(targets.primary - currentPrice) / stopDist;
    if (rr < MIN_RR_PRIMARY) return null; // enforce minimum R:R

    // ── Scoring ───────────────────────────────────────────────────────────────
    const components = this.zeroComponents();

    // HTF alignment (0–20): all 3 TFs best
    components.htfAlignment =
      bias.confidence === 'HIGH' ? 20 :
      bias.confidence === 'MEDIUM' ? 14 : 8;

    // Setup quality (0–20): EMA confluence + active layer count
    components.setupQuality = Math.min(20,
      emaAnalysis.score +                    // 0–12 from EMA
      (activeConfluences >= 3 ? 8 : activeConfluences === 2 ? 5 : 0)
    );

    // Momentum (0–15): MACD quality + trigger quality
    components.momentum = Math.min(15, Math.round(
      macdAnalysis.score * 0.5 + trigger.quality * 0.5
    ));

    // Volatility quality (0–10): Bollinger Band + RSI zone
    components.volatilityQuality = Math.min(10, bbAnalysis.score);

    // Regime fit (0–10)
    components.regimeFit =
      (regime === 'TREND_UP'   && isLong)  ? 10 :
      (regime === 'TREND_DOWN' && !isLong) ? 10 :
      regime === 'RANGE' ? 7 : 5;

    // Liquidity (0–10): volume + trigger volume confirm
    const avgVol4h = volumeAverage(candles4h, 20);
    const lastVol  = c4h.volume;
    const volRatio = avgVol4h > 0 ? lastVol / avgVol4h : 1;
    components.liquidity = Math.min(10,
      Math.round(volRatio * 6) + (trigger.hasVolumeConfirmation ? 3 : 0)
    );

    // Slippage (0–5): R:R quality
    components.slippageRisk = rr >= 3.5 ? 5 : rr >= 3.0 ? 4 : rr >= 2.5 ? 3 : 2;

    // Session quality (0–5)
    components.sessionQuality = sessionQualityScore();

    // Recent performance baseline
    components.recentPerformance = 3;

    const score = this.totalScore(components);
    const tier: ScoreTier =
      score >= 80 ? 'ELITE' :
      score >= 70 ? 'STRONG' :
      score >= MIN_SCORE ? 'MEDIUM' :
      'NO_TRADE';

    if (tier === 'NO_TRADE') return null;

    // ── Build metadata ────────────────────────────────────────────────────────
    const swingLevTiers = config.leverageTiers['swing'] as Record<string, number>;
    const suggestedLeverage = swingLevTiers[tier] ?? 5;
    const capitalAtRisk = stopPct * suggestedLeverage;

    const swingMeta: SwingMeta = {
      bias,
      zone: {
        priceLow:          stopLoss,
        priceHigh:         currentPrice,
        midpoint:          (stopLoss + currentPrice) / 2,
        confluenceScore:   activeConfluences,
        hasStructure:      true,
        hasEmaConfluence:  emaAnalysis.atEma20 || emaAnalysis.atEma50 || emaAnalysis.atEma200,
        hasFibLevel:       false,
        hasVolumeNode:     false,
        nearestFibPct:     null,
        notes:             emaAnalysis.nearestEmaLabel || 'confluence zone',
      },
      trigger: trigger.type,
      triggerQuality: trigger.quality,
      stopSwingPoint: stopPoint.price,
      primaryTP: targets.primary,
      extendedTP: targets.extended,
      rr,
      suggestedLeverage,
      capitalAtRiskPct: capitalAtRisk,
    };

    // ── Notes string for embed ────────────────────────────────────────────────
    const biasStr  = `W:${bias.weeklyBias[0]} D:${bias.dailyBias[0]} 4H:${bias.fourHourBias[0]}`;
    const confStr  = [
      emaAnalysis.nearestEmaLabel,
      bbAnalysis.label,
      macdAnalysis.label,
      trigger.label,
    ].filter(Boolean).join(' + ');

    const atrBuf = atr4h * 0.15;
    const entryZone: [number, number] = [currentPrice - atrBuf, currentPrice + atrBuf];

    return {
      id:         uuidv4(),
      strategy:   this.name,
      asset:      data.asset,
      direction:  isLong ? 'LONG' : 'SHORT',
      tradeType:  'SWING',
      entryZone,
      stopLoss,
      takeProfit: targets.primary,
      components,
      score,
      tier,
      regime,
      timestamp:  Date.now(),
      swingMeta,
      notes: `[${biasStr}] ${confStr} | SL=${(stopPct * 100).toFixed(2)}% | ${rr.toFixed(1)}:1 R:R | ${suggestedLeverage}x lev (${(capitalAtRisk * 100).toFixed(1)}% risk)${targets.extended ? ` | Ext TP: $${targets.extended.toFixed(2)}` : ''}`,
    };
  }

  // ─── EMA Zone Analysis ──────────────────────────────────────────────────────

  private analyseEmaZone(
    candles4h: OHLCV[],
    candles1d: OHLCV[],
    price: number,
    isLong: boolean,
    atr4h: number,
  ): EmaAnalysis {
    const n4h = candles4h.length - 1;

    const ema20Arr  = cachedEma(candles4h, 20);
    const ema50Arr  = cachedEma(candles4h, 50);
    const ema200Arr = cachedEma(candles4h, 200);

    const ema20  = ema20Arr[n4h]  ?? price;
    const ema50  = ema50Arr[n4h]  ?? price;
    const ema200 = ema200Arr[n4h] ?? price;

    const stackBullish = ema20 > ema50 && ema50 > ema200;
    const stackBearish = ema20 < ema50 && ema50 < ema200;

    const touch = atr4h * EMA_TOUCH_ATR_MULT;
    const atEma20  = Math.abs(price - ema20)  <= touch;
    const atEma50  = Math.abs(price - ema50)  <= touch;
    const atEma200 = Math.abs(price - ema200) <= touch;

    // Which EMA is price closest to?
    const dists = [
      { label: '20 EMA', d: Math.abs(price - ema20) },
      { label: '50 EMA', d: Math.abs(price - ema50) },
      { label: '200 EMA', d: Math.abs(price - ema200) },
    ].sort((a, b) => a.d - b.d);
    const nearestEmaLabel = atEma20 || atEma50 || atEma200 ? `@ ${dists[0].label}` : '';

    // Additional check: daily 50/200 EMA for bigger-picture zone
    const nd = candles1d.length - 1;
    const d50  = cachedEma(candles1d, 50)[nd]  ?? price;
    const d200 = cachedEma(candles1d, 200)[nd] ?? price;
    const atDaily50  = Math.abs(price - d50)  <= atr4h * 1.5;
    const atDaily200 = Math.abs(price - d200) <= atr4h * 1.5;

    // Scoring
    let score = 0;
    // Stack alignment
    if (isLong  && stackBullish) score += 4;
    if (!isLong && stackBearish) score += 4;
    // At a key 4h EMA
    if (atEma20)  score += 3;
    if (atEma50)  score += 4;
    if (atEma200) score += 5; // 200 EMA = premium zone
    // At a key daily EMA
    if (atDaily50)  score += 2;
    if (atDaily200) score += 3;
    score = Math.min(12, score); // cap at 12 (remainder goes to activeConfluences bonus)

    return { ema20, ema50, ema200, stackBullish, stackBearish, atEma20, atEma50, atEma200, nearestEmaLabel, score };
  }

  // ─── Bollinger Bands Analysis ───────────────────────────────────────────────

  private analyseBollingerBands(
    candles4h: OHLCV[],
    price: number,
    isLong: boolean,
  ): BbAnalysis {
    const bb = bollinger(candles4h, 20, 2);
    const n  = candles4h.length - 1;

    const upper  = bb.upper[n];
    const middle = bb.middle[n];
    const lower  = bb.lower[n];
    const width  = bb.width[n];

    if (isNaN(upper) || isNaN(lower)) {
      return { upper: price, middle: price, lower: price, width: 0, atUpperBand: false, atLowerBand: false, isSqueeze: false, isExpanding: false, score: 0, label: '' };
    }

    const bandRange  = upper - lower;
    const touchZone  = bandRange * 0.08; // within 8% of the band counts as "at band"
    const atUpperBand = price >= upper - touchZone;
    const atLowerBand = price <= lower + touchZone;

    // Squeeze: current width at or near 20-bar minimum
    const recentWidths = bb.width.slice(-20).filter((w) => !isNaN(w));
    const minWidth = recentWidths.length > 0 ? Math.min(...recentWidths) : Infinity;
    const isSqueeze  = width <= minWidth * 1.05; // within 5% of the tightest point

    // Expansion: width growing rapidly vs recent average
    const avgWidth = recentWidths.length > 0
      ? recentWidths.reduce((a, b) => a + b, 0) / recentWidths.length
      : width;
    const isExpanding = width > avgWidth * 1.1;

    // Label
    let label = '';
    if (isSqueeze && (atLowerBand || atUpperBand)) label = 'BB Squeeze+Band';
    else if (isSqueeze) label = 'BB Squeeze';
    else if (isLong  && atLowerBand) label = 'BB Lower Band';
    else if (!isLong && atUpperBand) label = 'BB Upper Band';
    else if (isExpanding) label = 'BB Expanding';

    // Score (0–10)
    let score = 0;
    if (isSqueeze) score += 5; // compression before move
    if (isLong  && atLowerBand) score += 5;
    if (!isLong && atUpperBand) score += 5;
    if (isExpanding) score += 3;
    score = Math.min(10, score);

    return { upper, middle, lower, width, atUpperBand, atLowerBand, isSqueeze, isExpanding, score, label };
  }

  // ─── MACD Momentum Analysis ─────────────────────────────────────────────────

  private analyseMacd(
    candles4h: OHLCV[],
    candles1d: OHLCV[],
    isLong: boolean,
  ): MacdAnalysis {
    const n4h = candles4h.length - 1;

    // Standard MACD(12,26,9) on 4h
    const macd4h = cachedMacd(candles4h, 12, 26, 9);
    const ml     = macd4h.macdLine;
    const sl     = macd4h.signalLine;
    const hist   = macd4h.histogram;

    const mlNow   = ml[n4h];
    const mlPrev  = ml[n4h - 1];
    const slNow   = sl[n4h];
    const slPrev  = sl[n4h - 1];
    const histNow = hist[n4h];
    const histPrev = hist[n4h - 1];

    const valid = !isNaN(mlNow) && !isNaN(mlPrev) && !isNaN(slNow) && !isNaN(slPrev);

    // Fresh MACD cross (within last 2 bars)
    const freshCross = valid && (
      isLong
        ? (mlPrev <= slPrev && mlNow > slNow)  // bullish cross
        : (mlPrev >= slPrev && mlNow < slNow)  // bearish cross
    );

    // MACD zero-line cross (strongest signal)
    const zeroCross = valid && (
      isLong  ? (mlPrev <= 0 && mlNow > 0) :
                (mlPrev >= 0 && mlNow < 0)
    );

    // Histogram inflection (turning positive/negative)
    const histInflection = !isNaN(histNow) && !isNaN(histPrev) && (
      isLong  ? (histPrev < 0 && histNow > histPrev) :  // histogram rising from negative
                (histPrev > 0 && histNow < histPrev)    // histogram falling from positive
    );

    // RSI bounce off key level on 4h
    const rsi4hVals = cachedRsi(candles4h, 14);
    const rsi4h     = rsi4hVals[n4h];
    const rsi4hPrev = rsi4hVals[n4h - 1];
    const rsiBounce = !isNaN(rsi4h) && !isNaN(rsi4hPrev) && (
      isLong
        ? (rsi4hPrev < 45 && rsi4h > rsi4hPrev && rsi4h < 65)  // bouncing from oversold territory
        : (rsi4hPrev > 55 && rsi4h < rsi4hPrev && rsi4h > 35)  // rolling from overbought territory
    );

    // Score (0–15)
    let score = 0;
    if (zeroCross)      score += 15; // strongest momentum signal
    else if (freshCross) score += 11;
    else if (histInflection) score += 8;
    if (rsiBounce) score += 4;
    score = Math.min(15, score);

    // Label for notes
    const label =
      zeroCross      ? 'MACD Zero Cross' :
      freshCross     ? 'MACD Cross' :
      histInflection ? 'MACD Hist Turn' :
      rsiBounce      ? 'RSI Bounce' : '';

    return { freshCross, zeroCross, histInflection, rsiBounce, score, label };
  }

  // ─── Entry Trigger (candlestick confirmation) ───────────────────────────────

  private detectEntryTrigger(
    candles4h: OHLCV[],
    candles15m: OHLCV[],
    isLong: boolean,
    avgAtr4h: number,
  ): TriggerResult | null {
    const last4h = candles4h.slice(-3);
    const avgVol = volumeAverage(candles4h, 20);

    // A: Bullish / Bearish Engulfing on 4h (highest quality)
    const engulfing = isLong
      ? isBullishEngulfing(last4h)
      : isBearishEngulfing(last4h);
    if (engulfing) {
      const hasVol = candles4h[candles4h.length - 1].volume > avgVol * 1.2;
      return { type: 'DISPLACEMENT', quality: 15, hasVolumeConfirmation: hasVol, label: 'Engulfing 4h' };
    }

    // B: Pin bar at EMA / BB level on 4h
    const lastCandle = candles4h[candles4h.length - 1];
    const pin = isLong ? isBullishPin(lastCandle) : isBearishPin(lastCandle);
    if (pin) {
      const hasVol = lastCandle.volume > avgVol * 1.1;
      return { type: 'DISPLACEMENT', quality: 13, hasVolumeConfirmation: hasVol, label: 'Pin Bar 4h' };
    }

    // C: Displacement candle (large body with volume)
    for (let i = candles4h.length - 1; i >= candles4h.length - 2; i--) {
      const c = candles4h[i];
      const body = Math.abs(c.close - c.open);
      const bullC = c.close > c.open;
      if (isLong ? !bullC : bullC) continue;
      if (body < avgAtr4h * DISPLACEMENT_BODY_ATR_MULT) continue;
      const hasVol = c.volume >= avgVol * DISPLACEMENT_VOLUME_MULT;
      const bodyRatio = body / avgAtr4h;
      const quality = Math.min(12, Math.round(bodyRatio * 7) + (hasVol ? 2 : 0));
      return { type: 'DISPLACEMENT', quality, hasVolumeConfirmation: hasVol, label: 'Displacement 4h' };
    }

    // D: RSI divergence on 4h
    const rsiVals4h = cachedRsi(candles4h, 14);
    const hasDivergence = isLong
      ? hasBullishDivergence(candles4h.slice(-30), rsiVals4h.slice(-30))
      : hasBearishDivergence(candles4h.slice(-30), rsiVals4h.slice(-30));
    if (hasDivergence) {
      const hasVol = lastCandle.volume > avgVol * 1.1;
      return { type: 'RSI_DIVERGENCE', quality: 11, hasVolumeConfirmation: hasVol, label: 'RSI Div 4h' };
    }

    // E: Liquidity sweep on 4h (spike below/above then reclaim)
    for (let i = candles4h.length - 1; i >= candles4h.length - 3; i--) {
      const c = candles4h[i];
      const threshold = c.close * 0.002;
      const isBull = isLong  && c.low  < c.close * 0.995 && c.close > c.open;
      const isBear = !isLong && c.high > c.close * 1.005 && c.close < c.open;
      if (!isBull && !isBear) continue;
      const hasVol = c.volume > avgVol * 1.2;
      const wickSize = isLong ? (c.open - c.low) : (c.high - c.open);
      const wickRatio = Math.abs(c.close - c.open) > 0 ? wickSize / Math.abs(c.close - c.open) : 1;
      const quality = Math.min(10, Math.round(wickRatio * 4 + 5) + (hasVol ? 1 : 0));
      return { type: 'LIQUIDITY_SWEEP', quality, hasVolumeConfirmation: hasVol, label: 'Liq Sweep 4h' };
    }

    // F: 15m confirmation (lower timeframe entry refinement — lower weight)
    if (candles15m.length >= 3) {
      const eng15 = isLong
        ? isBullishEngulfing(candles15m.slice(-3))
        : isBearishEngulfing(candles15m.slice(-3));
      if (eng15) {
        return { type: 'DISPLACEMENT', quality: 9, hasVolumeConfirmation: false, label: 'Engulfing 15m' };
      }
    }

    return null; // no trigger — skip this zone
  }
}
