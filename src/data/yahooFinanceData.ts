/**
 * Market data fetcher for non-crypto assets via Yahoo Finance.
 * Supports: XAU/USD (Gold), XAG/USD (Silver), QQQ/USD (Nasdaq ETF), SPY/USD (S&P 500 ETF)
 *
 * Yahoo Finance does not provide a native 4h interval, so '4h' requests fetch
 * 1h candles and aggregate them 4-into-1 to produce synthetic 4h candles.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { default: YahooFinance } = require('yahoo-finance2');

import type { OHLCV, Asset, Timeframe } from '../types';
import { logger } from '../utils/logger';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/** Assets sourced from Yahoo Finance instead of CCXT crypto exchanges */
const YAHOO_ASSETS = new Set<Asset>(['XAU/USD', 'XAG/USD', 'QQQ/USD', 'SPY/USD']);

/** Maps our internal Asset IDs to Yahoo Finance ticker symbols */
const YAHOO_SYMBOL_MAP: Record<string, string> = {
  'XAU/USD': 'GC=F',  // Gold Futures (~24h market Sun–Fri)
  'XAG/USD': 'SI=F',  // Silver Futures (~24h market Sun–Fri)
  'QQQ/USD': 'QQQ',   // Nasdaq-100 ETF (US market hours)
  'SPY/USD': 'SPY',   // S&P 500 ETF    (US market hours)
};

/**
 * Maps our internal timeframes to Yahoo Finance intervals.
 * '4h' is handled specially — fetches '1h' and aggregates.
 */
const YAHOO_INTERVAL_MAP: Record<string, string> = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '4h':  '1h',  // fetch 1h, then aggregate 4:1 into synthetic 4h candles
  '1d':  '1d',
  '1w':  '1wk',
};

/** Milliseconds per timeframe interval — used to compute period1 for fetching */
const INTERVAL_MS: Record<string, number> = {
  '1m':  60 * 1000,
  '5m':  5  * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '1d':  24 * 60 * 60 * 1000,
  '1wk': 7  * 24 * 60 * 60 * 1000,
};

export function isYahooAsset(asset: Asset): boolean {
  return YAHOO_ASSETS.has(asset);
}

/**
 * Aggregates sorted 1h candles into synthetic 4h candles (4-into-1).
 * Groups are aligned by index (0–3, 4–7, …). Incomplete trailing groups are dropped.
 */
function aggregate4h(candles1h: OHLCV[]): OHLCV[] {
  const result: OHLCV[] = [];
  for (let i = 0; i + 3 < candles1h.length; i += 4) {
    const group = candles1h.slice(i, i + 4);
    result.push({
      time:   group[0].time,
      open:   group[0].open,
      high:   Math.max(...group.map((c) => c.high)),
      low:    Math.min(...group.map((c) => c.low)),
      close:  group[3].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return result;
}

/**
 * Fetches OHLCV candles for a Yahoo Finance asset.
 *
 * For '4h': fetches '1h' candles × (limit × 4 + buffer), aggregates, and returns last `limit`.
 * For all others: fetches the native interval and returns last `limit`.
 */
export async function fetchYahooOHLCV(
  asset: Asset,
  timeframe: Timeframe,
  limit: number
): Promise<OHLCV[]> {
  const symbol = YAHOO_SYMBOL_MAP[asset];
  if (!symbol) throw new Error(`No Yahoo Finance symbol mapping for asset: ${asset}`);

  const is4h = timeframe === '4h';
  const yahooInterval = YAHOO_INTERVAL_MAP[timeframe];
  if (!yahooInterval) throw new Error(`Unsupported timeframe for Yahoo Finance: ${timeframe}`);

  // For 4h we need 4× as many 1h candles, plus a buffer for incomplete trailing groups
  const fetchLimit  = is4h ? limit * 4 + 8 : limit + 5;
  const intervalMs  = INTERVAL_MS[yahooInterval];
  const period1     = new Date(Date.now() - fetchLimit * intervalMs * 1.05); // 5% safety margin

  logger.debug(`[yahooFinance] Fetching ${asset} (${symbol}) ${yahooInterval} ~${fetchLimit} candles`);

  const result = await yahooFinance.chart(symbol, {
    period1,
    interval: yahooInterval as '1m' | '5m' | '15m' | '1h' | '1d' | '1wk',
  });

  if (!result?.quotes?.length) {
    // Market may be closed (e.g. QQQ/SPY on weekends, or 1m outside trading hours).
    // Return empty array — the caller (fetchMultiTimeframe) handles this gracefully.
    logger.debug(`[yahooFinance] No data for ${symbol} ${yahooInterval} — market likely closed`);
    return [];
  }

  // Map Yahoo's quote shape to our OHLCV interface
  const candles: OHLCV[] = result.quotes
    .filter(
      (q: { open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null; date: Date }) =>
        q.open != null && q.high != null && q.low != null && q.close != null
    )
    .map((q: { date: Date; open: number; high: number; low: number; close: number; volume: number | null }) => ({
      time:   q.date instanceof Date ? q.date.getTime() : Number(q.date),
      open:   q.open,
      high:   q.high,
      low:    q.low,
      close:  q.close,
      volume: q.volume ?? 0,
    }));

  // Aggregate 1h → 4h if needed
  const processed = is4h ? aggregate4h(candles) : candles;

  // Return last `limit` candles
  return processed.slice(-limit);
}

/**
 * Fetches the current mid-price for a Yahoo Finance asset.
 * Uses the `regularMarketPrice` from the quote endpoint.
 */
export async function fetchYahooCurrentPrice(asset: Asset): Promise<number> {
  const symbol = YAHOO_SYMBOL_MAP[asset];
  if (!symbol) throw new Error(`No Yahoo Finance symbol mapping for asset: ${asset}`);

  const quote = await yahooFinance.quote(symbol);
  const price = quote?.regularMarketPrice;
  if (!price || price <= 0) {
    throw new Error(`Yahoo Finance returned no valid price for ${symbol}`);
  }
  return price;
}
