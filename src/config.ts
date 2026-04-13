import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v.toLowerCase() === 'true';
}

export const config = {
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    signalChannelId: requireEnv('SIGNAL_CHANNEL_ID'),
    summaryChannelId: optionalEnv('SUMMARY_CHANNEL_ID', process.env['SIGNAL_CHANNEL_ID'] ?? ''),
    // Dedicated paper trading channel — populated at runtime by ready.ts.
    // Falls back to signalChannelId if the channel cannot be created.
    paperChannelId: optionalEnv('PAPER_CHANNEL_ID', ''),
  },

  anthropic: {
    apiKey: optionalEnv('ANTHROPIC_API_KEY', ''),
    model: 'claude-haiku-4-5-20251001',
  },

  trading: {
    assets: [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'PEPE/USDT',
      'XAU/USD',  'XAG/USD',  'QQQ/USD',  'SPY/USD',
    ] as string[],
    maxOpenPositions: optionalNum('MAX_OPEN_POSITIONS', 3),
    maxDailyLoss: optionalNum('MAX_DAILY_LOSS', 150),
    minScoreThreshold: optionalNum('MIN_SCORE_THRESHOLD', 60),
    maxLeverageScalp:  optionalNum('MAX_LEVERAGE_SCALP',  75),
    maxLeverageHybrid: optionalNum('MAX_LEVERAGE_HYBRID', 50),
    maxLeverageSwing:  optionalNum('MAX_LEVERAGE_SWING',  10),
    earlyProfitAlertPct: optionalNum('EARLY_PROFIT_ALERT_PCT', 0.25),
    targetReturnPct:     optionalNum('TARGET_RETURN_PCT',      0),
    autoExecuteEnabled: optionalBool('AUTO_EXECUTE_ENABLED', false),
  },

  engine: {
    scanIntervalMinutes: optionalNum('SCAN_INTERVAL_MINUTES', 5),
    enabled: optionalBool('ENABLED', true),
    exchangeId: optionalEnv('EXCHANGE_ID', 'binance'),
    duplicateWindowMs: 30 * 60 * 1000,          // 30 minutes for scalp/hybrid
    duplicateWindowMsSwing: 60 * 60 * 1000,      // 1 hour for swing signals
    staleThresholds: {
      '1w':  2 * 7 * 24 * 60 * 60 * 1000,
      '1d':  2 * 24 * 60 * 60 * 1000,
      '4h':  2 * 4 * 60 * 60 * 1000,
      '15m': 2 * 15 * 60 * 1000,
      '5m':  2 * 5 * 60 * 1000,
      '1m':  2 * 1 * 60 * 1000,
    } as Record<string, number>,
  },

  paper: {
    enabled: optionalBool('PAPER_TRADING_ENABLED', true),
    startingBalance: optionalNum('PAPER_BALANCE', 1000),
  },

  monitoring: {
    scalpIntervalSeconds: optionalNum('SCALP_MONITOR_INTERVAL_SECONDS', 90),
    swingIntervalSeconds: optionalNum('SWING_MONITOR_INTERVAL_SECONDS', 1200),
  },

  coingecko: {
    apiKey: optionalEnv('COINGECKO_API_KEY', ''),
  },

  paths: {
    data: path.join(process.cwd(), 'data'),
    tradesFile: path.join(process.cwd(), 'data', 'trades.json'),
    stateFile: path.join(process.cwd(), 'data', 'state.json'),
    paperTradesFile: path.join(process.cwd(), 'data', 'paper_trades.json'),
    paperStateFile: path.join(process.cwd(), 'data', 'paper_state.json'),
    blownAccountsFile: path.join(process.cwd(), 'data', 'blown_accounts.json'),
    topCryptosCache: path.join(process.cwd(), 'data', 'top_cryptos_cache.json'),
    logsDir: path.join(process.cwd(), 'logs'),
  },

  // SWING leverage is TIER-BASED (not dynamic). User target: 5-10x.
  leverageTiers: {
    scalp:  { ELITE: 20, STRONG: 15, MEDIUM: 10, NO_TRADE: 0 },
    hybrid: { ELITE: 50, STRONG: 35, MEDIUM: 15, NO_TRADE: 0 },
    swing:  { ELITE: 10, STRONG: 8,  MEDIUM: 5,  NO_TRADE: 0 },
  } as Record<string, Record<string, number>>,

  scoreTiers: {
    ELITE: 80,
    STRONG: 60,
    MEDIUM: 40,
  },

  assetLeverageCap: {
    'BTC/USDT': 20,
    'ETH/USDT': 20,
    'SOL/USDT': 20,
    'XRP/USDT': 20,
    'PEPE/USDT': 20,
    'XAU/USD': 10,
    'XAG/USD': 10,
    'QQQ/USD': 5,
    'SPY/USD': 5,
  } as Partial<Record<string, number>>,
  exchangeApi: {
    binanceApiKey: optionalEnv('BINANCE_API_KEY', ''),
    binanceSecret: optionalEnv('BINANCE_SECRET', ''),
  },
};

export type Config = typeof config;
