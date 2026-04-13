import type { OHLCV, Asset, Regime, RegimeResult } from '../types';
import { ema, atr, atrAverage, adx, bollinger, bollingerWidthMin } from '../indicators/indicators';

// ─── Regime cache (updated on every scan cycle) ───────────────────────────────

const lastRegimes = new Map<Asset, RegimeResult>();

export function setLastRegime(asset: Asset, result: RegimeResult): void {
  lastRegimes.set(asset, result);
}

export function getLastRegimes(): Map<Asset, RegimeResult> {
  return lastRegimes;
}

const ADX_TREND_THRESHOLD = 25;
const ADX_RANGE_THRESHOLD = 20;
const ATR_EXPANSION_RATIO = 1.5;
const ATR_COMPRESSION_RATIO = 0.7;
const ATR_EXTREME_RATIO = 3.0;
const MIN_VOLUME_PERCENTILE = 0.3; // volume must be at least 30% of average

export function detectRegime(asset: Asset, candles4h: OHLCV[]): RegimeResult {
  const n = candles4h.length;
  if (n < 50) {
    return {
      asset,
      regime: 'POOR',
      adx: 0,
      atrRatio: 0,
      emaAligned: false,
      timestamp: Date.now(),
    };
  }

  const ema20 = ema(candles4h, 20);
  const ema50 = ema(candles4h, 50);
  const ema200 = ema(candles4h, 200);
  const adxResult = adx(candles4h, 14);
  const atrValues = atr(candles4h, 14);
  const bbResult = bollinger(candles4h, 20, 2);

  const lastClose = candles4h[n - 1].close;
  const lastAdx = adxResult.adx[n - 1];
  const lastPdi = adxResult.pdi[n - 1];
  const lastMdi = adxResult.mdi[n - 1];
  const lastEma20 = ema20[n - 1];
  const lastEma50 = ema50[n - 1];
  const lastEma200 = ema200[n - 1];
  const lastAtr = atrValues[n - 1];

  // ATR ratio: current vs its own average
  const avgAtr = atrAverage(atrValues, 14);
  const atrRatio = avgAtr > 0 ? lastAtr / avgAtr : 1;

  // Check for extreme volatility → POOR
  if (atrRatio > ATR_EXTREME_RATIO) {
    return {
      asset,
      regime: 'POOR',
      adx: lastAdx,
      atrRatio,
      emaAligned: false,
      timestamp: Date.now(),
    };
  }

  // Check for NaN (not enough data)
  if (isNaN(lastAdx) || isNaN(lastEma200)) {
    return {
      asset,
      regime: 'POOR',
      adx: 0,
      atrRatio,
      emaAligned: false,
      timestamp: Date.now(),
    };
  }

  const emaUpAligned = lastEma20 > lastEma50 && lastEma50 > lastEma200;
  const emaDownAligned = lastEma20 < lastEma50 && lastEma50 < lastEma200;
  const emaAligned = emaUpAligned || emaDownAligned;

  // ── Volatility Expansion — checked BEFORE the volume gate ─────────────────
  // A breakout candle still forming will look low-volume even while ATR is
  // exploding. Detecting the expansion first prevents these moves being
  // silently dropped as POOR before the volume check is even reached.
  if (atrRatio > ATR_EXPANSION_RATIO) {
    return {
      asset,
      regime: 'VOL_EXPANSION',
      adx: lastAdx,
      atrRatio,
      emaAligned,
      timestamp: Date.now(),
    };
  }

  // Low volume check — use the last CLOSED candle (n-2), not the forming one (n-1).
  // A 4H candle that has only been open for 30 minutes will always look
  // low-volume compared to fully-closed candles, causing false POOR flags.
  const volCandle = n >= 2 ? candles4h[n - 2] : candles4h[n - 1];
  const avgVol =
    candles4h
      .slice(-20)
      .map((c) => c.volume)
      .reduce((a, b) => a + b, 0) / 20;
  const lowVolume = volCandle.volume < avgVol * MIN_VOLUME_PERCENTILE;

  if (lowVolume) {
    return {
      asset,
      regime: 'POOR',
      adx: lastAdx,
      atrRatio,
      emaAligned,
      timestamp: Date.now(),
    };
  }

  // Low Volatility Compression — Bollinger squeeze + ATR compression
  const currentBbWidth = bbResult.width[n - 1];
  const minBbWidth = bollingerWidthMin(bbResult.width, 20);
  const isSqueeze = !isNaN(currentBbWidth) && currentBbWidth <= minBbWidth * 1.05;
  if (atrRatio < ATR_COMPRESSION_RATIO && isSqueeze) {
    return {
      asset,
      regime: 'LOW_VOL_COMPRESSION',
      adx: lastAdx,
      atrRatio,
      emaAligned,
      timestamp: Date.now(),
    };
  }

  // Strong established uptrend (full 3-EMA alignment)
  if (
    lastAdx > ADX_TREND_THRESHOLD &&
    emaUpAligned &&
    lastClose > lastEma50 &&
    lastPdi > lastMdi
  ) {
    return {
      asset,
      regime: 'TREND_UP',
      adx: lastAdx,
      atrRatio,
      emaAligned: true,
      timestamp: Date.now(),
    };
  }

  // Fresh breakout uptrend — EMA20 crossed EMA50 but EMA200 hasn't caught up yet.
  // High ADX + clear directional dominance (PDI > MDI by 50%) = valid trend signal.
  if (
    lastAdx > 35 &&
    lastEma20 > lastEma50 &&
    lastClose > lastEma50 &&
    lastPdi > lastMdi * 1.5
  ) {
    return {
      asset,
      regime: 'TREND_UP',
      adx: lastAdx,
      atrRatio,
      emaAligned: false,
      timestamp: Date.now(),
    };
  }

  // Strong established downtrend (full 3-EMA alignment)
  if (
    lastAdx > ADX_TREND_THRESHOLD &&
    emaDownAligned &&
    lastClose < lastEma50 &&
    lastMdi > lastPdi
  ) {
    return {
      asset,
      regime: 'TREND_DOWN',
      adx: lastAdx,
      atrRatio,
      emaAligned: true,
      timestamp: Date.now(),
    };
  }

  // Fresh breakdown downtrend — EMA20 crossed below EMA50, strong directional dominance.
  if (
    lastAdx > 35 &&
    lastEma20 < lastEma50 &&
    lastClose < lastEma50 &&
    lastMdi > lastPdi * 1.5
  ) {
    return {
      asset,
      regime: 'TREND_DOWN',
      adx: lastAdx,
      atrRatio,
      emaAligned: false,
      timestamp: Date.now(),
    };
  }

  // Range
  if (lastAdx < ADX_RANGE_THRESHOLD) {
    return {
      asset,
      regime: 'RANGE',
      adx: lastAdx,
      atrRatio,
      emaAligned,
      timestamp: Date.now(),
    };
  }

  // Weak trend or mixed — still tradeable as RANGE for conservative approach
  return {
    asset,
    regime: 'RANGE',
    adx: lastAdx,
    atrRatio,
    emaAligned,
    timestamp: Date.now(),
  };
}

export function isTradeableRegime(regime: Regime): boolean {
  return regime !== 'POOR';
}

export function regimeLabel(regime: Regime): string {
  const labels: Record<Regime, string> = {
    TREND_UP: '📈 Trend Up',
    TREND_DOWN: '📉 Trend Down',
    RANGE: '↔️ Range',
    VOL_EXPANSION: '💥 Volatility Expansion',
    LOW_VOL_COMPRESSION: '🔇 Low-Vol Compression',
    POOR: '❌ Poor Conditions',
  };
  return labels[regime];
}
