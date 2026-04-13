/**
 * Fixed asset list — no network fetching required.
 *
 * Crypto pairs use Gate.io (CCXT) for OHLCV data.
 * Traditional assets (XAU, XAG, QQQ, SPY) use Yahoo Finance.
 *
 * If any crypto pair is unavailable on Gate.io the scan cycle skips it
 * gracefully (Promise.allSettled in marketData.ts).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ccxt = require('ccxt');
import { config } from '../config';
import { logger } from '../utils/logger';

export const CRYPTO_ASSETS = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'XRP/USDT',
  'PEPE/USDT',
  'BONK/USDT',
  'HYPE/USDT',
  'SHIB/USDT',
  'AERO/USDT',
  'TAO/USDT',
  'DOGE/USDT',
] as const;

export const TRADITIONAL_ASSETS = [
  'XAU/USD',
  'XAG/USD',
  'QQQ/USD',
  'SPY/USD',
] as const;

export const ALL_ASSETS: string[] = [
  ...CRYPTO_ASSETS,
  ...TRADITIONAL_ASSETS,
];

/** Loads the fixed asset list into config.trading.assets. Called once on startup. */
export function initializeTopCryptos(): void {
  config.trading.assets.length = 0;
  for (const a of ALL_ASSETS) config.trading.assets.push(a);
  logger.info(`Assets initialised: ${ALL_ASSETS.join(', ')}`);
}

/** No-op kept for compatibility — asset list is static, nothing to refresh. */
export function refreshTopCryptos(): void {
  logger.debug('topCryptos: static list — no refresh needed');
}

/** Returns the full asset list. */
export function getTopCryptoPairs(): string[] {
  return [...CRYPTO_ASSETS];
}

export interface AssetVerificationResult {
  ok: string[];
  failed: string[];
}

/**
 * Verifies all hardcoded crypto assets are fetchable on the configured exchange.
 * Runs at startup — non-blocking. Logs a clear OK/WARN summary so you can spot
 * unavailable tickers immediately in Render logs without digging through scan cycles.
 *
 * Traditional assets (XAU, XAG, QQQ, SPY) are verified via Yahoo Finance implicitly
 * at scan time; this function only checks Gate.io crypto pairs.
 */
export async function verifyAssets(): Promise<AssetVerificationResult> {
  const exchangeId: string = config.engine.exchangeId ?? 'gate';
  logger.info(`[assetVerify] Checking ${CRYPTO_ASSETS.length} crypto assets on ${exchangeId}…`);

  let exchange: any;
  try {
    const options: any = { enableRateLimit: true, timeout: 10000 };
    if (exchangeId === 'binance' || exchangeId === 'binanceusdm') {
      options.options = { defaultType: 'future' };
    } else if (exchangeId === 'gate' || exchangeId === 'gateio') {
      options.options = { defaultType: 'future' };
    } else if (exchangeId === 'mexc') {
      options.options = { defaultType: 'future' };
    }
    exchange = new ccxt[exchangeId](options);
  } catch (err) {
    logger.warn(`[assetVerify] Could not instantiate exchange "${exchangeId}": ${err}`);
    return { ok: [], failed: [...CRYPTO_ASSETS] };
  }

  const results = await Promise.allSettled(
    CRYPTO_ASSETS.map(async (symbol) => {
      // Fetch just 3 candles on the 1h timeframe — fast and lightweight
      const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 3);
      if (!Array.isArray(ohlcv) || ohlcv.length === 0) {
        throw new Error(`Empty OHLCV response for ${symbol}`);
      }
      return symbol;
    })
  );

  const ok: string[]     = [];
  const failed: string[] = [];

  results.forEach((r, i) => {
    const symbol = CRYPTO_ASSETS[i];
    if (r.status === 'fulfilled') {
      ok.push(symbol);
    } else {
      failed.push(symbol);
      logger.warn(`[assetVerify] ⚠️  ${symbol} — NOT available on ${exchangeId}: ${(r as PromiseRejectedResult).reason}`);
    }
  });

  if (failed.length === 0) {
    logger.info(`[assetVerify] ✅ All ${ok.length} crypto assets confirmed on ${exchangeId}`);
  } else {
    logger.warn(
      `[assetVerify] ${ok.length} OK, ${failed.length} FAILED: ${failed.join(', ')} — ` +
      `these symbols will be skipped silently each scan cycle`
    );
  }

  return { ok, failed };
}
