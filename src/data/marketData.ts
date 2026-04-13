// eslint-disable-next-line @typescript-eslint/no-require-imports
const ccxt = require('ccxt');
import type { OHLCV, Asset, Timeframe, MultiTimeframeData } from '../types';
import { getCached, setCache } from './cache';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isYahooAsset, fetchYahooOHLCV, fetchYahooCurrentPrice } from './yahooFinanceData';

// Candle limits per timeframe — swing analysis needs more history on HTF
const CANDLE_LIMITS: Record<string, number> = {
  '1w':  100,   // ~2 years of weekly structure
  '1d':  200,   // ~9 months of daily structure
  '4h':  200,
  '15m': 200,
  '5m':  200,
  '1m':  200,
};

const EXCHANGE_PRIORITY = ['binance', 'gate', 'mexc'];
const exchangePool: Record<string, any> = {};

function resolveStartIndex(): number {
  const id = config.engine.exchangeId;
  const idx = EXCHANGE_PRIORITY.indexOf(id);
  return idx >= 0 ? idx : 0;
}

function getPooledExchange(id: string): any {
  if (!exchangePool[id]) {
    logger.info(`[marketData] Initialising exchange: ${id}`);
    const options: any = {
      enableRateLimit: true,
      timeout: 10000,
    };
    // Configure for futures trading where applicable
    if (id === 'binance' || id === 'binanceusdm') {
      options.options = { defaultType: 'future' };
    } else if (id === 'gate' || id === 'gateio') {
      options.options = { defaultType: 'future' };
    } else if (id === 'mexc') {
      options.options = { defaultType: 'future' };
    }
    exchangePool[id] = new ccxt[id](options);
  }
  return exchangePool[id];
}

function isAvailabilityError(err: unknown): boolean {
  return err instanceof ccxt.ExchangeNotAvailable || err instanceof ccxt.NetworkError;
}

async function withFallback<T>(fn: (ex: any) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = resolveStartIndex(); i < EXCHANGE_PRIORITY.length; i++) {
    const id = EXCHANGE_PRIORITY[i];
    try {
      return await fn(getPooledExchange(id));
    } catch (err) {
      lastErr = err;
      if (!isAvailabilityError(err)) throw err;
      logger.warn(
        `[marketData] Exchange "${id}" unavailable (${(err as Error).message?.slice(0, 80)}). ` +
          `Falling back to "${EXCHANGE_PRIORITY[i + 1] ?? 'none'}".`
      );
    }
  }
  throw lastErr;
}

function toOHLCV(raw: any[][]): OHLCV[] {
  return raw.map((c) => ({
    time: c[0] as number,
    open: c[1] as number,
    high: c[2] as number,
    low: c[3] as number,
    close: c[4] as number,
    volume: c[5] as number,
  }));
}

function checkStaleness(candles: OHLCV[], timeframe: Timeframe): void {
  if (candles.length === 0) return; // empty = market closed, already logged upstream
  const staleThreshold = config.engine.staleThresholds[timeframe];
  const lastCandle = candles[candles.length - 1];
  const age = Date.now() - lastCandle.time;
  if (age > staleThreshold) {
    logger.warn(
      `Stale data for ${timeframe}: last candle is ${Math.round(age / 1000)}s old — using anyway`
    );
  }
}

export async function fetchOHLCV(
  asset: Asset,
  timeframe: Timeframe,
  limit?: number
): Promise<OHLCV[]> {
  const resolvedLimit = limit ?? CANDLE_LIMITS[timeframe] ?? 200;
  const cached = getCached(asset, timeframe);
  if (cached) return cached;

  logger.debug(`Fetching ${asset} ${timeframe} (${resolvedLimit} candles)`);

  let candles: OHLCV[];
  if (isYahooAsset(asset)) {
    candles = await fetchYahooOHLCV(asset, timeframe, resolvedLimit);
  } else {
    const raw = await withFallback<any[][]>((ex) =>
      ex.fetchOHLCV(asset, timeframe, undefined, resolvedLimit)
    );
    candles = toOHLCV(raw);
  }

  checkStaleness(candles, timeframe);
  setCache(asset, timeframe, candles);

  return candles;
}

export async function fetchMultiTimeframe(asset: Asset): Promise<MultiTimeframeData> {
  const TFS = ['1w', '1d', '4h', '15m', '5m', '1m'] as const;

  const results = await Promise.allSettled(
    TFS.map((tf) => fetchOHLCV(asset, tf))
  );

  const data: Record<string, OHLCV[]> = {};
  for (let i = 0; i < TFS.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      data[TFS[i]] = r.value;
    } else {
      // Timeframe unavailable (e.g. 1m for equities outside market hours) — use empty array.
      // Each strategy checks candles.length < minimum and returns null gracefully.
      logger.debug(`[fetchMultiTimeframe] ${asset} ${TFS[i]} unavailable: ${(r as PromiseRejectedResult).reason?.message ?? r.reason}`);
      data[TFS[i]] = [];
    }
  }

  return {
    asset,
    '1w':  data['1w'],
    '1d':  data['1d'],
    '4h':  data['4h'],
    '15m': data['15m'],
    '5m':  data['5m'],
    '1m':  data['1m'],
  };
}

export async function fetchCurrentPrice(asset: Asset): Promise<number> {
  if (isYahooAsset(asset)) {
    return fetchYahooCurrentPrice(asset);
  }
  const ticker = await withFallback<any>((ex) => ex.fetchTicker(asset));
  const mid = (ticker.bid != null && ticker.ask != null) ? (ticker.bid + ticker.ask) / 2 : undefined;
  const price = ticker.last ?? ticker.close ?? mid;
  if (!price || price <= 0) {
    throw new Error(`Could not determine current price for ${asset} — ticker fields all null/zero`);
  }
  return price;
}

/**
 * Fetch the current bid-ask spread for a given asset.
 * Returns the spread as a percentage (ask - bid) / mid price.
 * For Yahoo assets, returns a default spread (0.0001).
 */
export async function fetchSpread(asset: Asset): Promise<number> {
  if (isYahooAsset(asset)) {
    // Yahoo Finance doesn't provide bid/ask for futures; assume tight spread
    return 0.0001;
  }
  const ticker = await withFallback<any>((ex) => ex.fetchTicker(asset));
  const bid = ticker.bid;
  const ask = ticker.ask;
  if (bid != null && ask != null && bid > 0 && ask > bid) {
    const mid = (bid + ask) / 2;
    return (ask - bid) / mid;
  }
  // Fallback: use a default based on asset liquidity
  const lowLiq = ['BONK/USDT', 'SHIB/USDT', 'PEPE/USDT', 'FLOKI/USDT'].includes(asset);
  return lowLiq ? 0.0015 : 0.0007;
}

export async function fetchAllAssets(): Promise<MultiTimeframeData[]> {
  // Use allSettled so one bad symbol (e.g. a CoinGecko coin not listed on Gate.io)
  // never kills the entire scan cycle — failed assets are skipped with a warning.
  const results = await Promise.allSettled(
    config.trading.assets.map((asset) => fetchMultiTimeframe(asset as Asset))
  );
  const successful: MultiTimeframeData[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      successful.push(r.value);
    } else {
      logger.warn(`fetchAllAssets: skipping ${config.trading.assets[i]} — ${(r.reason as Error)?.message ?? r.reason}`);
    }
  }
  return successful;
}
