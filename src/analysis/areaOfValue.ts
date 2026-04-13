/**
 * Area of Value Detection
 *
 * Identifies price zones where ≥2 of these criteria converge:
 *   1. STRUCTURE  — prior swing high/low (Daily or 4h)
 *   2. EMA CONFLUENCE — Daily + 4h EMAs clustered here
 *   3. FIBONACCI — 50% or 61.8% retracement level
 *   4. VOLUME NODE — high-volume consolidation zone
 *
 * Zones with confluenceScore ≥ 2 are valid areas of value for swing entries.
 */

import { swingPoints } from '../indicators/indicators';
import { cachedEma } from '../indicators/cache';
import type { OHLCV, AreaOfValue } from '../types';

const ZONE_WIDTH_PCT   = 0.008;
const FIB_LEVELS       = [0.5, 0.618] as const;
const VOLUME_NODE_RATIO = 1.8;
const DAILY_SWING_CFG  = { left: 3, right: 3, max: 16 };
const FOUR_H_SWING_CFG = { left: 4, right: 4, max: 20 };

function collectStructuralLevels(candles1d: OHLCV[], candles4h: OHLCV[]): number[] {
  const dailyPoints = swingPoints(candles1d, DAILY_SWING_CFG.left, DAILY_SWING_CFG.right, DAILY_SWING_CFG.max);
  const fourHPoints = swingPoints(candles4h, FOUR_H_SWING_CFG.left, FOUR_H_SWING_CFG.right, FOUR_H_SWING_CFG.max);
  return [...dailyPoints, ...fourHPoints].map((p) => p.price);
}

function collectEmaLevels(candles1d: OHLCV[], candles4h: OHLCV[]): { level: number; label: string }[] {
  const result: { level: number; label: string }[] = [];
  for (const period of [20, 50, 200] as const) {
    const dailyEma = cachedEma(candles1d, period);
    const fourHEma = cachedEma(candles4h, period);
    const dailyVal = dailyEma[dailyEma.length - 1];
    const fourHVal = fourHEma[fourHEma.length - 1];
    if (!isNaN(dailyVal)) result.push({ level: dailyVal, label: `Daily EMA${period}` });
    if (!isNaN(fourHVal)) result.push({ level: fourHVal, label: `4h EMA${period}` });
  }
  return result;
}

function computeFibLevels(candles1d: OHLCV[]): { level: number; fibPct: number; label: string }[] {
  if (candles1d.length < 20) return [];
  const recent = candles1d.slice(-60);
  const points = swingPoints(recent, 3, 3, 20);
  if (points.length < 2) return [];
  const highs = points.filter((p) => p.type === 'HIGH');
  const lows  = points.filter((p) => p.type === 'LOW');
  if (!highs.length || !lows.length) return [];
  const swingHigh = Math.max(...highs.map((h) => h.price));
  const swingLow  = Math.min(...lows.map((l) => l.price));
  const range = swingHigh - swingLow;
  if (range <= 0) return [];
  const result: { level: number; fibPct: number; label: string }[] = [];
  for (const fib of FIB_LEVELS) {
    result.push({ level: swingHigh - range * fib, fibPct: fib, label: `${(fib * 100).toFixed(1)}% Fib` });
    result.push({ level: swingLow  + range * fib, fibPct: fib, label: `${(fib * 100).toFixed(1)}% Fib (bear)` });
  }
  return result;
}

function detectVolumeNodes(candles: OHLCV[], buckets = 20): number[] {
  if (candles.length < 20) return [];
  const recent = candles.slice(-100);
  const prices = recent.map((c) => (c.high + c.low) / 2);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = maxP - minP;
  if (range <= 0) return [];
  const bucketWidth = range / buckets;
  const volumeByBucket = new Array(buckets).fill(0);
  for (const c of recent) {
    const mid = (c.high + c.low) / 2;
    const idx = Math.min(Math.floor((mid - minP) / bucketWidth), buckets - 1);
    volumeByBucket[idx] += c.volume;
  }
  const avg = volumeByBucket.reduce((a: number, b: number) => a + b, 0) / buckets;
  return volumeByBucket
    .map((v: number, i: number) => v > avg * VOLUME_NODE_RATIO ? minP + (i + 0.5) * bucketWidth : null)
    .filter((n): n is number => n !== null);
}

function findExistingZone(candidateLevel: number, zoneCentres: number[]): number {
  for (let i = 0; i < zoneCentres.length; i++) {
    if (Math.abs(candidateLevel - zoneCentres[i]) / zoneCentres[i] <= ZONE_WIDTH_PCT * 2) return i;
  }
  return -1;
}

const WEEKLY_ZONE_TOLERANCE = 0.008; // ±0.8%

function collectWeeklyStructuralLevels(candles1w: OHLCV[], currentPrice: number): number[] {
  if (candles1w.length < 2) return [];
  const recent = candles1w.slice(-8); // last 8 weekly candles
  const levels: number[] = [];
  for (const candle of recent) {
    const highDist = Math.abs(candle.high - currentPrice) / currentPrice;
    const lowDist  = Math.abs(candle.low  - currentPrice) / currentPrice;
    if (highDist <= 0.15) levels.push(candle.high); // within 15% of current price
    if (lowDist  <= 0.15) levels.push(candle.low);
  }
  return levels;
}

export function findAreasOfValue(
  candles1w: OHLCV[],
  candles1d: OHLCV[],
  candles4h: OHLCV[],
  currentPrice: number,
  isLong: boolean
): AreaOfValue[] {
  const searchRadius = currentPrice * 0.10;
  const minPrice = isLong ? currentPrice * 0.85 : currentPrice;
  const maxPrice = isLong ? currentPrice : currentPrice * 1.15;

  const inRange = (p: number) => p >= minPrice - searchRadius && p <= maxPrice + searchRadius;

  // Weekly structural levels — highest priority zones (strength/priority 3)
  const weeklyLevels = collectWeeklyStructuralLevels(candles1w, currentPrice).filter(inRange);
  const structuralLevels = collectStructuralLevels(candles1d, candles4h).filter(inRange);
  const emaLevels        = collectEmaLevels(candles1d, candles4h).filter((e) => inRange(e.level));
  const fibLevels        = computeFibLevels(candles1d).filter((f) => inRange(f.level));
  const volumeNodes      = detectVolumeNodes(candles4h).filter(inRange);

  const zoneCentres: number[] = [];
  const zoneData: {
    levels: number[]; hasStructure: boolean;
    emaLabels: string[]; fibLabels: string[];
    hasVolumeNode: boolean; fibPct: number | null;
  }[] = [];

  function mergeOrCreate(level: number, patch: Partial<typeof zoneData[0]>) {
    const idx = findExistingZone(level, zoneCentres);
    if (idx === -1) {
      zoneCentres.push(level);
      zoneData.push({ levels: [level], hasStructure: false, emaLabels: [], fibLabels: [], hasVolumeNode: false, fibPct: null, ...patch });
    } else {
      Object.assign(zoneData[idx], patch);
      zoneData[idx].levels.push(level);
      zoneCentres[idx] = zoneData[idx].levels.reduce((a, b) => a + b, 0) / zoneData[idx].levels.length;
    }
  }

  // Process weekly levels first (highest priority)
  for (const level of weeklyLevels) mergeOrCreate(level, { hasStructure: true });
  for (const level of structuralLevels) mergeOrCreate(level, { hasStructure: true });
  for (const ema of emaLevels) {
    const idx = findExistingZone(ema.level, zoneCentres);
    if (idx === -1) {
      zoneCentres.push(ema.level);
      zoneData.push({ levels: [ema.level], hasStructure: false, emaLabels: [ema.label], fibLabels: [], hasVolumeNode: false, fibPct: null });
    } else {
      zoneData[idx].emaLabels.push(ema.label);
    }
  }
  for (const fib of fibLevels) {
    const idx = findExistingZone(fib.level, zoneCentres);
    if (idx === -1) {
      zoneCentres.push(fib.level);
      zoneData.push({ levels: [fib.level], hasStructure: false, emaLabels: [], fibLabels: [fib.label], hasVolumeNode: false, fibPct: fib.fibPct });
    } else {
      zoneData[idx].fibLabels.push(fib.label);
      if (zoneData[idx].fibPct === null) zoneData[idx].fibPct = fib.fibPct;
    }
  }
  for (const node of volumeNodes) {
    const idx = findExistingZone(node, zoneCentres);
    if (idx === -1) {
      zoneCentres.push(node);
      zoneData.push({ levels: [node], hasStructure: false, emaLabels: [], fibLabels: [], hasVolumeNode: true, fibPct: null });
    } else {
      zoneData[idx].hasVolumeNode = true;
    }
  }

  const areas: AreaOfValue[] = [];

  for (let i = 0; i < zoneCentres.length; i++) {
    const centre = zoneCentres[i];
    const data   = zoneData[i];

    if (isLong  && centre >= currentPrice * 1.005) continue;
    if (!isLong && centre <= currentPrice * 0.995) continue;

    const hasDailyEma     = data.emaLabels.some((l) => l.startsWith('Daily'));
    const has4hEma        = data.emaLabels.some((l) => l.startsWith('4h'));
    const hasEmaConfluence = (hasDailyEma && has4hEma) || data.emaLabels.some((l) => l.includes('200') || l.includes('50'));
    const hasFibLevel     = data.fibLabels.length > 0;

    let confluenceScore = 0;
    if (data.hasStructure)  confluenceScore++;
    if (hasEmaConfluence)   confluenceScore++;
    if (hasFibLevel)        confluenceScore++;
    if (data.hasVolumeNode) confluenceScore++;

    const noteParts: string[] = [];
    if (data.hasStructure)  noteParts.push('Structure');
    if (hasEmaConfluence)   noteParts.push(data.emaLabels.slice(0, 2).join('+'));
    if (hasFibLevel)        noteParts.push(data.fibLabels[0]);
    if (data.hasVolumeNode) noteParts.push('Vol Node');

    areas.push({
      priceHigh:        centre * (1 + ZONE_WIDTH_PCT),
      priceLow:         centre * (1 - ZONE_WIDTH_PCT),
      midpoint:         centre,
      confluenceScore,
      hasStructure:     data.hasStructure,
      hasEmaConfluence,
      hasFibLevel,
      hasVolumeNode:    data.hasVolumeNode,
      nearestFibPct:    data.fibPct,
      notes:            `${noteParts.join(' + ')} @ $${centre.toFixed(2)} [${confluenceScore}/4]`,
    });
  }

  return areas
    .filter((a) => a.confluenceScore >= 1)
    .sort((a, b) => {
      if (b.confluenceScore !== a.confluenceScore) return b.confluenceScore - a.confluenceScore;
      return Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice);
    });
}

export function isPriceInZone(price: number, zone: AreaOfValue, tolerancePct = 0.003): boolean {
  return price >= zone.priceLow * (1 - tolerancePct) && price <= zone.priceHigh * (1 + tolerancePct);
}
