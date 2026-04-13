import type { OHLCV, Asset, Timeframe } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

interface CacheEntry {
  data: OHLCV[];
  fetchedAt: number;
}

type CacheKey = `${Asset}:${Timeframe}`;

const store = new Map<CacheKey, CacheEntry>();

function makeKey(asset: Asset, timeframe: Timeframe): CacheKey {
  return `${asset}:${timeframe}`;
}

export function getCached(asset: Asset, timeframe: Timeframe): OHLCV[] | null {
  const entry = store.get(makeKey(asset, timeframe));
  if (!entry) return null;

  const staleThreshold = config.engine.staleThresholds[timeframe];
  const age = Date.now() - entry.fetchedAt;
  if (age > staleThreshold) {
    logger.warn(`Cache stale for ${asset} ${timeframe} (age=${Math.round(age / 1000)}s)`);
    return null;
  }
  return entry.data;
}

export function setCache(asset: Asset, timeframe: Timeframe, data: OHLCV[]): void {
  store.set(makeKey(asset, timeframe), { data, fetchedAt: Date.now() });
}

export function clearCache(): void {
  store.clear();
}

export function isCacheFresh(asset: Asset, timeframe: Timeframe): boolean {
  return getCached(asset, timeframe) !== null;
}
