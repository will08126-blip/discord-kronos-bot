import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { TextChannel } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { StrategySignal, PaperTrade, PaperState, PaperCloseReason, ScalpEntryMetadata } from '../types';
import { fetchCurrentPrice, fetchOHLCV, fetchSpread } from '../data/marketData';
import type { Asset } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { cachedRsi, cachedAtr, cachedMacd, cachedFVGs, cachedEmaQuickTrend } from '../indicators/cache';
import { volumeAverage } from '../indicators/indicators';

// ─── Aggressive mode constants ────────────────────────────────────────────────
// The user explicitly wants to stress-test the strategy. Losing the $1,000 is
// acceptable — the goal is to surface weaknesses fast and collect data.

const PAPER_RISK_PCT        = 0.05;   // 5% of balance risked per trade
const PAPER_MAX_CONCURRENT  = 4;      // max active+pending positions simultaneously
const PAPER_MAX_LEVERAGE    = 20;     // hard leverage cap (realistic for crypto)
const PAPER_SCALP_MAX_HOLD  = 240;   // max minutes to hold a scalp (4 hours)
const PAPER_SWING_MAX_HOLD  = 4320;  // max minutes to hold a swing (72 hours)
const PAPER_PENDING_EXPIRY  = 15;    // minutes before a pending scalp order expires
const PAPER_CB_LOSS_COUNT   = 5;     // consecutive losses before circuit breaker
const PAPER_CB_COOLDOWN_MIN = 60;    // minutes to pause after circuit breaker triggers
const PAPER_BLOWN_THRESHOLD = 50;    // balance floor — auto-reset below this
const PAPER_RESET_DELAY_MIN = 10;    // minutes to wait before resetting blown account
const MAKER_FEE = 0.0002;             // 0.02% maker fee (Binance Futures)
const TAKER_FEE = 0.0002;             // 0.02% taker fee (Binance Futures)

// ─── Async lock for state updates ─────────────────────────────────────────────
let stateLock: Promise<any> = Promise.resolve();
function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = stateLock.then(() => fn());
  stateLock = result.catch(() => {}) as Promise<any>; // continue lock chain even if error
  return result;
}

// Set synchronously BEFORE acquiring the lock so that any concurrent
// checkPaperPositions / enterPaperTrade that is mid-execution (awaiting
// a price fetch) will see this flag when it returns and skip its stale writes.
let resetInProgress = false;
// Rate-limit Discord notifications for blocked entry attempts (module-level)
let lastBlownNotifTime  = 0;
let lastCBNotifTime     = 0;

// ─── Slippage model ───────────────────────────────────────────────────────────
// Low-liquidity / meme coins face wider spreads than major pairs.

const LOW_LIQ_ASSETS = new Set([
  'BONK/USDT', 'SHIB/USDT', 'PEPE/USDT', 'FLOKI/USDT',
]);

function isLowLiq(asset: string): boolean {
  if (LOW_LIQ_ASSETS.has(asset)) return true;
  const base = asset.split('/')[0].toUpperCase();
  return base.includes('INU') || base.includes('DOGE');
}

async function getSlipPct(asset: string): Promise<number> {
  // Base spread from exchange
  let spread: number;
  try {
    spread = await fetchSpread(asset as Asset);
  } catch (err) {
    logger.warn(`paperTrading: fetchSpread failed for ${asset}, using default:`, err);
    // Fallback default spread based on liquidity
    const lowLiq = isLowLiq(asset);
    spread = lowLiq ? 0.0015 : 0.0007;
  }
  
  // Time-of-day adjustment: lower liquidity during Asian session (00:00-08:00 UTC) and weekend
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  
  // Increase spread during low liquidity periods
  if (hourUTC >= 0 && hourUTC < 8) {
    spread *= 1.5; // Asian session lower liquidity
  }
  if (isWeekend) {
    spread *= 1.2;
  }
  
  // Ensure minimum spread for low-liq assets
  const lowLiq = isLowLiq(asset);
  const minSpread = lowLiq ? 0.0015 : 0.0007;
  return Math.max(spread, minSpread);
}

// ─── State persistence ────────────────────────────────────────────────────────

function ensureDataDir(): void {
  fs.mkdirSync(config.paths.data, { recursive: true });
}

export function loadPaperState(): PaperState {
  ensureDataDir();
  try {
    if (fs.existsSync(config.paths.paperStateFile)) {
      const raw = fs.readFileSync(config.paths.paperStateFile, 'utf-8');
      const parsed = JSON.parse(raw) as PaperState;
      // Back-fill new fields for older state files
      parsed.consecutiveLosses  = parsed.consecutiveLosses  ?? 0;
      return parsed;
    }
  } catch {
    logger.warn('paperTrading: could not load paper state, using defaults');
  }
  return {
    virtualBalance: config.paper.startingBalance,
    startingBalance: config.paper.startingBalance,
    lastUpdated: new Date().toISOString(),
    consecutiveLosses: 0,
  };
}

function savePaperState(state: PaperState): void {
  ensureDataDir();
  state.lastUpdated = new Date().toISOString();
  const tmp = config.paths.paperStateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.paths.paperStateFile);
}

export function loadPaperTrades(): PaperTrade[] {
  ensureDataDir();
  try {
    if (fs.existsSync(config.paths.paperTradesFile)) {
      const raw = fs.readFileSync(config.paths.paperTradesFile, 'utf-8');
      return JSON.parse(raw) as PaperTrade[];
    }
  } catch {
    logger.warn('paperTrading: could not load paper trades, starting fresh');
  }
  return [];
}

function savePaperTrades(trades: PaperTrade[]): void {
  ensureDataDir();
  const tmp = config.paths.paperTradesFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, config.paths.paperTradesFile);
}

// ─── Blown-accounts log ───────────────────────────────────────────────────────

interface BlownRecord {
  timestamp: string;
  finalBalance: number;
  startingBalance: number;
  totalTrades: number;
  winRate: number;
  totalPnlDollar: number;
}

function appendBlownRecord(record: BlownRecord): void {
  ensureDataDir();
  const file = config.paths.blownAccountsFile;
  let history: BlownRecord[] = [];
  try {
    if (fs.existsSync(file)) {
      history = JSON.parse(fs.readFileSync(file, 'utf-8')) as BlownRecord[];
    }
  } catch {
    history = [];
  }
  history.push(record);
  fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

// ─── Embed builders ───────────────────────────────────────────────────────────

function buildPaperPendingEmbed(trade: PaperTrade): { embeds: EmbedBuilder[] } {
  const assetLabel = trade.asset.split('/')[0];
  const dirEmoji = trade.direction === 'LONG' ? '🟢' : '🔴';
  const expiresIn = trade.pendingExpiresAt
    ? Math.round((new Date(trade.pendingExpiresAt).getTime() - Date.now()) / 60000)
    : PAPER_PENDING_EXPIRY;
  const embed = new EmbedBuilder()
    .setColor(0xffaa00)
    .setTitle(`⏳ Paper Pending: ${dirEmoji} ${trade.direction} ${assetLabel}`)
    .setDescription(
      `**Limit @ $${trade.pendingEntryPrice?.toFixed(4)}** | SL: $${trade.stopLoss.toFixed(4)} | TP: $${trade.takeProfit.toFixed(4)}\n` +
      `Waiting for price to reach entry zone · Expires in ${expiresIn}min\n` +
      `Risk: $${trade.positionSizeDollars.toFixed(2)} (${(PAPER_RISK_PCT * 100).toFixed(0)}%) | Leverage: ${trade.leverage}x | ${trade.strategy}`
    )
    .setTimestamp()
    .setFooter({ text: `Paper Pending · ID: ${trade.id.slice(0, 8)}` });
  return { embeds: [embed] };
}

function buildPaperFilledEmbed(
  trade: PaperTrade,
  slippageDollar: number,
  slippagePct: number,
  balanceRemaining: number,
): { embeds: EmbedBuilder[] } {
  const assetLabel = trade.asset.split('/')[0];
  const dirEmoji = trade.direction === 'LONG' ? '🟢' : '🔴';
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`✅ Paper Trade Filled: ${dirEmoji} ${trade.direction} ${assetLabel}`)
    .setDescription(
      `**@ $${trade.entryPrice.toFixed(4)}** | SL: $${trade.stopLoss.toFixed(4)} | TP: $${trade.takeProfit.toFixed(4)}\n` +
      `Risk: $${trade.positionSizeDollars.toFixed(2)} | Leverage: ${trade.leverage}x | Slippage: $${slippageDollar.toFixed(4)} (${(slippagePct * 100).toFixed(2)}%)\n` +
      `Balance remaining: $${balanceRemaining.toFixed(2)} | Strategy: ${trade.strategy}`
    )
    .setTimestamp()
    .setFooter({ text: `Paper Trade · ID: ${trade.id.slice(0, 8)} · ${trade.tradeType} · ${trade.strategy}` });
  return { embeds: [embed] };
}

function buildPaperEntryEmbed(
  trade: PaperTrade,
  slippageDollar: number,
  slippagePct: number,
  balanceRemaining: number,
): { embeds: EmbedBuilder[] } {
  const assetLabel = trade.asset.split('/')[0];
  const dirEmoji = trade.direction === 'LONG' ? '🟢' : '🔴';
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📄 Paper Trade Entered: ${dirEmoji} ${trade.direction} ${assetLabel}`)
    .setDescription(
      `**@ $${trade.entryPrice.toFixed(4)}** | SL: $${trade.stopLoss.toFixed(4)} | TP: $${trade.takeProfit.toFixed(4)}\n` +
      `Risk: $${trade.positionSizeDollars.toFixed(2)} | Leverage: ${trade.leverage}x | Slippage: $${slippageDollar.toFixed(4)} (${(slippagePct * 100).toFixed(2)}%)\n` +
      `Balance remaining: $${balanceRemaining.toFixed(2)} | Strategy: ${trade.strategy}`
    )
    .setTimestamp()
    .setFooter({ text: `Paper Trade · ID: ${trade.id.slice(0, 8)} · ${trade.tradeType} · ${trade.strategy}` });
  return { embeds: [embed] };
}

function buildPaperExpiredEmbed(trade: PaperTrade): { embeds: EmbedBuilder[] } {
  const assetLabel = trade.asset.split('/')[0];
  const embed = new EmbedBuilder()
    .setColor(0x888888)
    .setTitle(`⌛ Pending Expired: ${assetLabel}`)
    .setDescription(
      `Price never reached $${trade.pendingEntryPrice?.toFixed(4)} within ${PAPER_PENDING_EXPIRY} minutes.\n` +
      `Strategy: ${trade.strategy}`
    )
    .setTimestamp()
    .setFooter({ text: `Paper Pending Expired · ID: ${trade.id.slice(0, 8)}` });
  return { embeds: [embed] };
}

function buildPaperCloseEmbed(trade: PaperTrade): { embeds: EmbedBuilder[] } {
  const assetLabel = trade.asset.split('/')[0];
  const isWin = (trade.pnlDollar ?? 0) > 0;
  const pnlSign = isWin ? '+' : '';
  const pnlDollar = trade.pnlDollar ?? 0;
  const pnlR = trade.pnlR ?? 0;
  const rSign = pnlR >= 0 ? '+' : '';
  const embed = new EmbedBuilder()
    .setColor(isWin ? 0x00ff87 : 0xff4444)
    .setTitle(`📄 Paper Trade Closed: ${assetLabel} ${isWin ? 'WIN ✅' : 'LOSS ❌'}`)
    .setDescription(
      `**Entry:** $${trade.entryPrice.toFixed(4)} → **Exit:** $${(trade.exitPrice ?? 0).toFixed(4)}\n` +
      `**P&L:** ${pnlSign}$${pnlDollar.toFixed(2)} (${rSign}${pnlR.toFixed(2)}R)\n` +
      `**Reason:** ${trade.closeReason ?? 'unknown'} | **Hold:** ${trade.holdMinutes ?? 0}min | **Balance:** $${(trade.balanceAfter ?? 0).toFixed(2)}`
    )
    .setTimestamp()
    .setFooter({ text: `Paper Trade · ${trade.tradeType} · ${trade.strategy}` });
  return { embeds: [embed] };
}

function buildCircuitBreakerEmbed(lossCount: number): { embeds: EmbedBuilder[] } {
  const embed = new EmbedBuilder()
    .setColor(0xff6600)
    .setTitle('⚠️ Paper Trading Paused — Circuit Breaker Triggered')
    .setDescription(
      `**${lossCount} consecutive losses detected.**\n` +
      `All new paper trade entries are paused for **${PAPER_CB_COOLDOWN_MIN} minutes**.\n\n` +
      `This is valuable signal — something systematic is going wrong. ` +
      `Existing open positions continue to be monitored.`
    )
    .setTimestamp()
    .setFooter({ text: 'Paper Trading will resume automatically after cooldown' });
  return { embeds: [embed] };
}

function buildBlownAccountEmbed(
  finalBalance: number,
  tradeCount: number,
  winRate: number,
): { embeds: EmbedBuilder[] } {
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('📄 Paper Account Blown 💥')
    .setDescription(
      `**Final Balance: $${finalBalance.toFixed(2)}** | Started: $${config.paper.startingBalance.toFixed(2)}\n` +
      `Total Trades: ${tradeCount} | Win Rate: ${(winRate * 100).toFixed(1)}%\n\n` +
      `This is valuable stress-test data. Full stats logged to \`blown_accounts.json\`.\n` +
      `**Resetting to $${config.paper.startingBalance.toFixed(2)} in ${PAPER_RESET_DELAY_MIN} minutes...**`
    )
    .setTimestamp()
    .setFooter({ text: `Paper Trading will auto-reset in ${PAPER_RESET_DELAY_MIN} minutes` });
  return { embeds: [embed] };
}

function buildAccountResetEmbed(newBalance: number): { embeds: EmbedBuilder[] } {
  const embed = new EmbedBuilder()
    .setColor(0x00c8ff)
    .setTitle('🔄 Paper Account Reset')
    .setDescription(
      `Virtual balance restored to **$${newBalance.toFixed(2)}**.\n` +
      `Paper trading resumed. All open positions cleared.`
    )
    .setTimestamp()
    .setFooter({ text: 'Paper Trading restarted' });
  return { embeds: [embed] };
}

// ─── Account blow / reset helpers ────────────────────────────────────────────

async function triggerAccountBlow(state: PaperState, channel: TextChannel): Promise<void> {
  const trades = loadPaperTrades().filter((t) => t.status === 'closed');
  const wins = trades.filter((t) => (t.pnlDollar ?? 0) > 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const totalPnl = state.virtualBalance - state.startingBalance;

  // Log to blown_accounts.json
  appendBlownRecord({
    timestamp: new Date().toISOString(),
    finalBalance: state.virtualBalance,
    startingBalance: state.startingBalance,
    totalTrades: trades.length,
    winRate,
    totalPnlDollar: totalPnl,
  });

  // Mark as blown — enterPaperTrade and checkPaperPositions will skip entries
  state.blownAt = new Date().toISOString();
  // Reset consecutive losses and circuit breaker so they start fresh after reset
  state.consecutiveLosses = 0;
  state.circuitBreakerUntil = undefined;
  savePaperState(state);

  await channel.send(buildBlownAccountEmbed(state.virtualBalance, trades.length, winRate));
  logger.warn(
    `[paperTrading] Account blown — balance $${state.virtualBalance.toFixed(2)} < $${PAPER_BLOWN_THRESHOLD}` +
    ` — auto-reset in ${PAPER_RESET_DELAY_MIN} minutes`
  );
}

async function performAccountReset(state: PaperState, channel: TextChannel): Promise<void> {
  const startingBalance = config.paper.startingBalance;

  // Clear all open/pending positions (no P&L — account is blown)
  savePaperTrades([]);

  // Fresh state — explicitly clear blown/circuit-breaker flags so no stale
  // state can block new entries after the reset
  const freshState: PaperState = {
    virtualBalance:      startingBalance,
    startingBalance,
    lastUpdated:         new Date().toISOString(),
    consecutiveLosses:   0,
    blownAt:             undefined,
    circuitBreakerUntil: undefined,
  };
  savePaperState(freshState);

  await channel.send(buildAccountResetEmbed(startingBalance));
  logger.info(`[paperTrading] Account auto-reset — balance restored to $${startingBalance}, all positions cleared`);
}

// ─── Entry metadata capture ───────────────────────────────────────────────────

async function captureEntryMetadata(
  signal: StrategySignal,
  currentPrice: number,
): Promise<ScalpEntryMetadata | undefined> {
  try {
    const asset = signal.asset as Asset;
    const [candles1m, candles5m, candles15m] = await Promise.all([
      fetchOHLCV(asset, '1m', 50).catch(() => null),
      fetchOHLCV(asset, '5m', 50).catch(() => null),
      fetchOHLCV(asset, '15m', 30).catch(() => null),
    ]);

    const now = new Date();
    const meta: ScalpEntryMetadata = {
      hourUTC: now.getUTCHours(),
      dayOfWeekUTC: now.getUTCDay(),
      rsi5m: NaN,
      macdHist5m: NaN,
      macdCrossed5m: false,
      trend5m: 'NEUTRAL',
      rsi1m: NaN,
      atr1m: NaN,
      volumeRatio1m: 1,
      trend15m: 'NEUTRAL',
      rsi15m: NaN,
      hasFVG: false,
      fvgType: 'NONE',
      fvgStrength: 0,
      signalScore: signal.score,
      signalTier: signal.tier,
      regime: signal.regime,
      stopDistPct: Math.abs(currentPrice - signal.stopLoss) / currentPrice,
    };

    if (candles5m && candles5m.length >= 20) {
      const n5 = candles5m.length - 1;
      meta.rsi5m   = cachedRsi(candles5m, 14)[n5] ?? NaN;
      meta.trend5m = cachedEmaQuickTrend(candles5m, 8, 21);
      const macd5  = cachedMacd(candles5m, 5, 13, 3);
      meta.macdHist5m = macd5.histogram[n5] ?? NaN;
      const prevMacd = macd5.macdLine[n5 - 1] ?? NaN;
      const prevSig  = macd5.signalLine[n5 - 1] ?? NaN;
      const curMacd  = macd5.macdLine[n5] ?? NaN;
      const curSig   = macd5.signalLine[n5] ?? NaN;
      meta.macdCrossed5m =
        !isNaN(prevMacd) && !isNaN(prevSig) && !isNaN(curMacd) && !isNaN(curSig) &&
        ((prevMacd <= prevSig && curMacd > curSig) || (prevMacd >= prevSig && curMacd < curSig));

      const fvgs5m = cachedFVGs(candles5m, 5);
      const isLong = signal.direction === 'LONG';
      const nearby = fvgs5m.filter(
        (z) => Math.abs(z.midpoint - currentPrice) / currentPrice <= 0.015 &&
               (isLong ? z.type === 'BULLISH' : z.type === 'BEARISH')
      );
      if (nearby.length > 0) {
        meta.hasFVG      = true;
        meta.fvgType     = nearby[0].type;
        meta.fvgStrength = nearby[0].strength;
      }
    }

    if (candles1m && candles1m.length >= 15) {
      const n1 = candles1m.length - 1;
      meta.rsi1m = cachedRsi(candles1m, 14)[n1] ?? NaN;
      meta.atr1m = cachedAtr(candles1m, 14)[n1] ?? NaN;
      const volAvg = volumeAverage(candles1m, 20);
      meta.volumeRatio1m = volAvg > 0 ? (candles1m[n1].volume / volAvg) : 1;

      if (!meta.hasFVG) {
        const fvgs1m = cachedFVGs(candles1m, 8);
        const isLong = signal.direction === 'LONG';
        const nearby = fvgs1m.filter(
          (z) => Math.abs(z.midpoint - currentPrice) / currentPrice <= 0.015 &&
                 (isLong ? z.type === 'BULLISH' : z.type === 'BEARISH')
        );
        if (nearby.length > 0) {
          meta.hasFVG      = true;
          meta.fvgType     = nearby[0].type;
          meta.fvgStrength = nearby[0].strength;
        }
      }
    }

    if (candles15m && candles15m.length >= 20) {
      const n15 = candles15m.length - 1;
      meta.rsi15m   = cachedRsi(candles15m, 14)[n15] ?? NaN;
      meta.trend15m = cachedEmaQuickTrend(candles15m, 8, 21);
    }

    return meta;
  } catch (err) {
    logger.warn(`paperTrading: captureEntryMetadata failed for ${signal.asset}: ${err}`);
    return undefined;
  }
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Enter a new paper trade.
 *
 * For SCALP signals: creates a PENDING limit order at signal.entryZone[0].
 * The order fills if price touches that level within 15 minutes.
 *
 * For SWING/HYBRID: enters immediately at currentPrice with slippage applied.
 *
 * Respects:
 *  - Circuit breaker (5 consecutive losses → 60 min pause)
 *  - Blown-account cooldown (balance < $50 → 10 min pause then auto-reset)
 *  - Max concurrent positions (4)
 */
export async function enterPaperTrade(
  signal: StrategySignal,
  currentPrice: number,
  channel: TextChannel,
): Promise<void> {
  if (!config.paper.enabled) return;

  await withStateLock(async () => {
    let state = loadPaperState();

    // ── Blown account cooldown ────────────────────────────────────────────
    if (state.blownAt) {
      const msElapsed = Date.now() - new Date(state.blownAt).getTime();
      if (msElapsed >= PAPER_RESET_DELAY_MIN * 60 * 1000) {
        // Cooldown elapsed — reset and continue
        await performAccountReset(state, channel);
        state = loadPaperState(); // reload fresh state after reset
      } else {
        const minsLeft = Math.ceil((PAPER_RESET_DELAY_MIN * 60 * 1000 - msElapsed) / 60000);
        logger.debug(`paperTrading: blown cooldown — ${minsLeft}min remaining, skip ${signal.asset}`);
        // Notify the channel at most once every 10 minutes to avoid spam
        if (Date.now() - lastBlownNotifTime > 10 * 60 * 1000) {
          lastBlownNotifTime = Date.now();
          await channel.send({
            embeds: [new EmbedBuilder()
              .setColor(0xffaa00)
              .setTitle('⏸ Paper Trading Paused — Account Blown')
              .setDescription(
                `Virtual balance fell below $${PAPER_BLOWN_THRESHOLD}. Auto-restarting in **${minsLeft} minute(s)**.\n` +
                `Use \`/paper-reset\` to restart immediately.`
              )
              .setTimestamp()
              .setFooter({ text: 'Paper trading only — no real money affected' })],
          });
        }
        return;
      }
    }

    // ── Circuit breaker ───────────────────────────────────────────────────
    if (state.circuitBreakerUntil) {
      const cbUntil = new Date(state.circuitBreakerUntil).getTime();
      if (Date.now() < cbUntil) {
        const minsLeft = Math.ceil((cbUntil - Date.now()) / 60000);
        logger.info(`paperTrading: circuit breaker active until ${state.circuitBreakerUntil} — skip ${signal.asset}`);
        // Notify the channel at most once every 10 minutes to avoid spam
        if (Date.now() - lastCBNotifTime > 10 * 60 * 1000) {
          lastCBNotifTime = Date.now();
          await channel.send({
            embeds: [new EmbedBuilder()
              .setColor(0xff6600)
              .setTitle('⚠️ Paper Trading Paused — Circuit Breaker Active')
              .setDescription(
                `Trading paused after ${state.consecutiveLosses} consecutive losses. Resuming in **${minsLeft} minute(s)**.\n` +
                `Use \`/paper-reset\` to clear immediately.`
              )
              .setTimestamp()
              .setFooter({ text: 'Paper trading only — no real money affected' })],
          });
        }
        return;
      }
      // Expired — clear it
      state.circuitBreakerUntil = undefined;
      savePaperState(state);
    }

    // ── Concurrent position limit ─────────────────────────────────────────
    const trades = loadPaperTrades();
    const openCount = trades.filter((t) => t.status === 'active' || t.status === 'pending').length;
    if (openCount >= PAPER_MAX_CONCURRENT) {
      logger.debug(`paperTrading: max concurrent (${PAPER_MAX_CONCURRENT}) reached — skip ${signal.asset}`);
      return;
    }

    // ── Risk calculation ──────────────────────────────────────────────────
    const slip   = await getSlipPct(signal.asset);
    const isLong = signal.direction === 'LONG';
    const isScalp = signal.tradeType === 'SCALP';

    // Leverage: 1/stopDistPct so that a full stop-distance move = 100% of margin lost.
    // Capped at PAPER_MAX_LEVERAGE (20x) for realism.
    const stopDistPct = Math.abs(currentPrice - signal.stopLoss) / currentPrice;
    const leverage = stopDistPct > 0
      ? Math.min(Math.round(1 / stopDistPct), PAPER_MAX_LEVERAGE)
      : 10;

    // riskDollars = how much we're willing to lose on this trade (5% of balance)
    const riskDollars = state.virtualBalance * PAPER_RISK_PCT;

    if (isScalp) {
      // ── Pending limit order (SCALP) ─────────────────────────────────────
      // Wait for price to retrace INTO the entry zone rather than chasing the
      // midpoint. This is how real FVG scalps are entered.
      const pendingEntryPrice = signal.entryZone[0];
      const pendingExpiresAt  = new Date(Date.now() + PAPER_PENDING_EXPIRY * 60 * 1000).toISOString();
      const meta = await captureEntryMetadata(signal, currentPrice);

      const trade: PaperTrade = {
        id:                 uuidv4(),
        asset:              signal.asset,
        direction:          signal.direction,
        entryPrice:         pendingEntryPrice,  // updated with slippage on fill
        currentPrice,
        stopLoss:           signal.stopLoss,
        takeProfit:         signal.takeProfit,
        positionSizeDollars: riskDollars,
        leverage,
        strategy:           signal.strategy,
        tradeType:          signal.tradeType,
        status:             'pending',
        openTime:           new Date().toISOString(),
        pendingEntryPrice,
        pendingExpiresAt,
        meta,
      };

      if (resetInProgress) {
        logger.warn('[enterPaperTrade] Reset in progress — discarding stale pending entry');
        return;
      }
      trades.push(trade);
      savePaperTrades(trades);

      await channel.send(buildPaperPendingEmbed(trade));
      logger.info(
        `paperTrading: pending ${trade.direction} ${trade.asset} limit@${pendingEntryPrice} expires@${pendingExpiresAt} (id=${trade.id.slice(0, 8)})`
      );

    } else {
      // ── Immediate entry (SWING / HYBRID) ───────────────────────────────
      // Apply slippage at time of entry.
      const entryPrice = isLong
        ? currentPrice * (1 + slip)
        : currentPrice * (1 - slip);
      const slippageDollar = Math.abs(entryPrice - currentPrice);
      const meta = await captureEntryMetadata(signal, entryPrice);

      const trade: PaperTrade = {
        id:                 uuidv4(),
        asset:              signal.asset,
        direction:          signal.direction,
        entryPrice,
        currentPrice,
        stopLoss:           signal.stopLoss,
        takeProfit:         signal.takeProfit,
        positionSizeDollars: riskDollars,
        leverage,
        strategy:           signal.strategy,
        tradeType:          signal.tradeType,
        status:             'active',
        openTime:           new Date().toISOString(),
        meta,
      };

      if (resetInProgress) {
        logger.warn('[enterPaperTrade] Reset in progress — discarding stale active entry');
        return;
      }
      trades.push(trade);
      savePaperTrades(trades);

      await channel.send(buildPaperEntryEmbed(trade, slippageDollar, slip, state.virtualBalance));
      logger.info(
        `paperTrading: entered ${trade.direction} ${trade.asset} @ ${entryPrice.toFixed(4)} ` +
        `(slippage=${(slip * 100).toFixed(2)}%, id=${trade.id.slice(0, 8)})`
      );
    }
  });

}

/**
 * Poll all active and pending paper positions.
 *
 * Pending orders: fill if price touches the limit level; cancel if expired.
 * Active trades:  check SL/TP (using exact SL/TP price, not poll-time price),
 *                 enforce max hold time, track consecutive losses,
 *                 trigger circuit breaker, detect account blow.
 */
export async function checkPaperPositions(channel: TextChannel): Promise<void> {
  if (!config.paper.enabled) return;

  await withStateLock(async () => {
    // ── Blown account handling ─────────────────────────────────────────────────
    const stateCheck = loadPaperState();
    if (stateCheck.blownAt) {
      const msElapsed = Date.now() - new Date(stateCheck.blownAt).getTime();
      if (msElapsed >= PAPER_RESET_DELAY_MIN * 60 * 1000) {
        await performAccountReset(stateCheck, channel);
      } else {
        const minsLeft = Math.ceil((PAPER_RESET_DELAY_MIN * 60 * 1000 - msElapsed) / 60000);
        logger.debug(`paperTrading: blown cooldown — ${minsLeft}min until auto-reset, skipping position check`);
      }
      return;
    }

    const trades = loadPaperTrades();
    const pendingTrades = trades.filter((t) => t.status === 'pending');
    const activeTrades  = trades.filter((t) => t.status === 'active');

    if (pendingTrades.length === 0 && activeTrades.length === 0) return;

    const state: PaperState = loadPaperState();
    let stateChanged  = false;
    let tradesChanged = false;

    // ── Process pending orders ──────────────────────────────────────────────────
    for (const trade of pendingTrades) {
      try {
        const currentPrice = await fetchCurrentPrice(trade.asset as Asset);
        trade.currentPrice = currentPrice;
        tradesChanged = true;

        const isLong = trade.direction === 'LONG';
        const limitPrice = trade.pendingEntryPrice!;

        // Check expiry first
        if (trade.pendingExpiresAt && Date.now() > new Date(trade.pendingExpiresAt).getTime()) {
          trade.status      = 'closed';
          trade.closeTime   = new Date().toISOString();
          trade.closeReason = 'pending expired';
          trade.exitPrice   = currentPrice;
          trade.pnlDollar   = 0;
          trade.pnlR        = 0;
          trade.pnlPct      = 0;
          trade.holdMinutes = 0;
          trade.balanceAfter = state.virtualBalance;

          await channel.send(buildPaperExpiredEmbed(trade));
          logger.info(`paperTrading: pending expired for ${trade.asset} @ limit=${limitPrice} (id=${trade.id.slice(0, 8)})`);
          continue;
        }

        // Check if price has reached the limit
        const triggered = isLong
          ? currentPrice <= limitPrice
          : currentPrice >= limitPrice;

        if (triggered) {
          // Fill the order — apply slippage on fill
          const slip       = await getSlipPct(trade.asset);
          const fillPrice  = isLong
            ? limitPrice * (1 + slip)
            : limitPrice * (1 - slip);
          const slippageDollar = Math.abs(fillPrice - limitPrice);

          trade.status     = 'active';
          trade.entryPrice = fillPrice;
          // openTime stays the same — when the pending order was placed

          await channel.send(buildPaperFilledEmbed(trade, slippageDollar, slip, state.virtualBalance));
          logger.info(
            `paperTrading: pending filled ${trade.direction} ${trade.asset} @ ${fillPrice.toFixed(4)} ` +
            `(limit=${limitPrice}, slip=${(slip * 100).toFixed(2)}%, id=${trade.id.slice(0, 8)})`
          );
        }
      } catch (err) {
        logger.warn(`paperTrading: error processing pending trade ${trade.id.slice(0, 8)}:`, err);
      }
    }

    // ── Process active positions ────────────────────────────────────────────────
    for (const trade of activeTrades) {
      try {
        const currentPrice = await fetchCurrentPrice(trade.asset as Asset);
        trade.currentPrice = currentPrice;
        tradesChanged = true;

        const isLong       = trade.direction === 'LONG';
        const nowMs        = Date.now();
        const openMs       = new Date(trade.openTime).getTime();
        const holdMinutes  = Math.round((nowMs - openMs) / 60000);
        const maxHoldMin   = trade.tradeType === 'SWING' ? PAPER_SWING_MAX_HOLD : PAPER_SCALP_MAX_HOLD;

        const hitSL  = isLong ? currentPrice <= trade.stopLoss  : currentPrice >= trade.stopLoss;
        const hitTP  = isLong ? currentPrice >= trade.takeProfit : currentPrice <= trade.takeProfit;
        const timed  = holdMinutes >= maxHoldMin;

        if (hitSL || hitTP || timed) {
          // ── Determine exit price ────────────────────────────────────────
          // SL/TP hits: use the exact SL/TP level (realistic order fill).
          // Max hold time or other closes: use poll-time price.
          let exitPrice: number;
          let closeReason: PaperCloseReason;

          if (hitTP) {
            exitPrice   = trade.takeProfit;
            closeReason = 'TP hit';
          } else if (hitSL) {
            exitPrice   = trade.stopLoss;
            closeReason = 'SL hit';
          } else {
            exitPrice   = currentPrice;
            closeReason = 'max hold time';
          }

          // ── P&L calculation ─────────────────────────────────────────────
          // pnlR = how many R-multiples we made/lost.
          // pnlDollar = pnlR × riskDollars ensures that -1R = losing the
          // full risk amount (positionSizeDollars = 5% of balance at entry).
          const pnlPct = isLong
            ? (exitPrice - trade.entryPrice) / trade.entryPrice
            : (trade.entryPrice - exitPrice) / trade.entryPrice;
          const stopDistPct = Math.abs(trade.entryPrice - trade.stopLoss) / trade.entryPrice;
          const pnlR      = stopDistPct > 0 ? pnlPct / stopDistPct : 0;
          const pnlDollar = pnlR * trade.positionSizeDollars;

          // Fee calculation (Binance Futures: 0.02% taker fee per side)
          const notional = stopDistPct > 0 ? trade.positionSizeDollars / stopDistPct : trade.positionSizeDollars;
          const fee = notional * TAKER_FEE * 2; // entry + exit
          const netPnl = pnlDollar - fee;

          const closeTime = new Date().toISOString();

          trade.status      = 'closed';
          trade.closeTime   = closeTime;
          trade.exitPrice   = exitPrice;
          trade.pnlDollar   = netPnl;
          trade.pnlR        = pnlR;
          trade.pnlPct      = pnlPct;
          trade.holdMinutes = holdMinutes;
          trade.closeReason = closeReason;
          trade.balanceAfter = state.virtualBalance + netPnl;

          state.virtualBalance += netPnl;
          stateChanged = true;

          // ── Consecutive loss tracking ────────────────────────────────────
          if (netPnl > 0) {
            state.consecutiveLosses = 0;
          } else {
            state.consecutiveLosses = (state.consecutiveLosses ?? 0) + 1;
          }

          // ── Circuit breaker trigger ──────────────────────────────────────
          const cbLosses = state.consecutiveLosses ?? 0;
          if (cbLosses >= PAPER_CB_LOSS_COUNT && !state.circuitBreakerUntil) {
            state.circuitBreakerUntil = new Date(
              Date.now() + PAPER_CB_COOLDOWN_MIN * 60 * 1000
            ).toISOString();
            await channel.send(buildCircuitBreakerEmbed(cbLosses));
            logger.warn(
              `paperTrading: circuit breaker triggered after ${cbLosses} consecutive losses` +
              ` — pausing entries until ${state.circuitBreakerUntil}`
            );
          }

          await channel.send(buildPaperCloseEmbed(trade));
          logger.info(
            `paperTrading: closed ${trade.direction} ${trade.asset} — ` +
            `${closeReason} P&L=$${pnlDollar.toFixed(2)} (${pnlR.toFixed(2)}R) ` +
            `balance=$${state.virtualBalance.toFixed(2)}`
          );
        }
      } catch (err) {
        logger.warn(`paperTrading: error checking position ${trade.id.slice(0, 8)}:`, err);
      }
    }

    // Skip stale writes if a reset was triggered while we were awaiting price fetches
    if (resetInProgress) {
      logger.warn('[checkPaperPositions] Reset in progress — discarding stale writes');
      return;
    }
    if (tradesChanged) savePaperTrades(trades);
    if (stateChanged)  savePaperState(state);

    // ── Account blow check ──────────────────────────────────────────────────────
    // Re-load state after saves to get updated balance
    const freshState = loadPaperState();
    if (freshState.virtualBalance < PAPER_BLOWN_THRESHOLD && !freshState.blownAt) {
      await triggerAccountBlow(freshState, channel);
    }
  });
}

/**
 * Manually close a paper position (e.g. EMA breakdown detection).
 * Exits at current market price; slippage is NOT applied (assume market order urgency).
 */
export async function closePaperPosition(
  tradeId: string,
  channel: TextChannel,
  reason: 'EMA breakdown' | 'manual' = 'manual',
): Promise<void> {
  await withStateLock(async () => {
    const trades = loadPaperTrades();
    const trade  = trades.find((t) => t.id === tradeId && t.status === 'active');
    if (!trade) return;

    const state = loadPaperState();
    try {
      const currentPrice = await fetchCurrentPrice(trade.asset as Asset);
      const isLong = trade.direction === 'LONG';

      const pnlPct = isLong
        ? (currentPrice - trade.entryPrice) / trade.entryPrice
        : (trade.entryPrice - currentPrice) / trade.entryPrice;
      const stopDistPct = Math.abs(trade.entryPrice - trade.stopLoss) / trade.entryPrice;
      const pnlR      = stopDistPct > 0 ? pnlPct / stopDistPct : 0;
      const pnlDollar = pnlR * trade.positionSizeDollars;

      const holdMinutes = Math.round(
        (Date.now() - new Date(trade.openTime).getTime()) / 60000
      );

      // Fee calculation (Binance Futures: 0.02% taker fee per side)
      const notional = stopDistPct > 0 ? trade.positionSizeDollars / stopDistPct : trade.positionSizeDollars;
      const fee = notional * TAKER_FEE * 2; // entry + exit
      const netPnl = pnlDollar - fee;

      trade.status      = 'closed';
      trade.closeTime   = new Date().toISOString();
      trade.exitPrice   = currentPrice;
      trade.pnlDollar   = netPnl;
      trade.pnlR        = pnlR;
      trade.pnlPct      = pnlPct;
      trade.holdMinutes = holdMinutes;
      trade.closeReason = reason;
      trade.balanceAfter = state.virtualBalance + netPnl;

      state.virtualBalance += netPnl;

      // Update consecutive losses
      if (netPnl > 0) {
        state.consecutiveLosses = 0;
      } else {
        state.consecutiveLosses = (state.consecutiveLosses ?? 0) + 1;
      }

      savePaperTrades(trades);
      savePaperState(state);

      await channel.send(buildPaperCloseEmbed(trade));
    } catch (err) {
      logger.error('paperTrading: closePaperPosition error:', err);
    }
  });
}

// ─── Stats & query functions ───────────────────────────────────────────────────

export interface PaperStats {
  virtualBalance: number;
  startingBalance: number;
  balanceChangePct: number;
  openPositions: number;
  pendingPositions: number;
  todayTrades: number;
  todayWins: number;
  todayLosses: number;
  todayPnlDollar: number;
  allTimeTrades: number;
  allTimeWins: number;
  winRate: number;
  totalPnlDollar: number;
  profitFactor: number;
  currentStreak: number;
  streakType: 'win' | 'loss' | 'none';
  consecutiveLosses: number;
  circuitBreakerActive: boolean;
  circuitBreakerUntil?: string;
  lastUpdated: string;
}

export function getPaperStats(): PaperStats {
  const state  = loadPaperState();
  const trades = loadPaperTrades();
  const closed  = trades.filter((t) => t.status === 'closed' && t.closeReason !== 'pending expired');
  const open    = trades.filter((t) => t.status === 'active');
  const pending = trades.filter((t) => t.status === 'pending');
  const today   = new Date().toISOString().slice(0, 10);
  const todayTrades  = closed.filter((t) => (t.closeTime ?? '').slice(0, 10) === today);
  const todayWins    = todayTrades.filter((t) => (t.pnlDollar ?? 0) > 0);
  const todayLosses  = todayTrades.filter((t) => (t.pnlDollar ?? 0) <= 0);

  const wins       = closed.filter((t) => (t.pnlDollar ?? 0) > 0);
  const losses     = closed.filter((t) => (t.pnlDollar ?? 0) <= 0);
  const grossProfit = wins.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + (t.pnlDollar ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  // Current streak
  let streak = 0;
  let streakType: 'win' | 'loss' | 'none' = 'none';
  for (let i = closed.length - 1; i >= 0; i--) {
    const pnl   = closed[i].pnlDollar ?? 0;
    const isWin = pnl > 0;
    if (streak === 0) {
      streakType = isWin ? 'win' : 'loss';
      streak = 1;
    } else if ((isWin && streakType === 'win') || (!isWin && streakType === 'loss')) {
      streak++;
    } else {
      break;
    }
  }

  const cbActive = !!(
    state.circuitBreakerUntil &&
    Date.now() < new Date(state.circuitBreakerUntil).getTime()
  );

  return {
    virtualBalance:      state.virtualBalance,
    startingBalance:     state.startingBalance,
    balanceChangePct:    (state.virtualBalance - state.startingBalance) / state.startingBalance,
    openPositions:       open.length,
    pendingPositions:    pending.length,
    todayTrades:         todayTrades.length,
    todayWins:           todayWins.length,
    todayLosses:         todayLosses.length,
    todayPnlDollar:      todayTrades.reduce((s, t) => s + (t.pnlDollar ?? 0), 0),
    allTimeTrades:       closed.length,
    allTimeWins:         wins.length,
    winRate:             closed.length > 0 ? wins.length / closed.length : 0,
    totalPnlDollar:      grossProfit - grossLoss,
    profitFactor,
    currentStreak:       streak,
    streakType:          closed.length > 0 ? streakType : 'none',
    consecutiveLosses:   state.consecutiveLosses ?? 0,
    circuitBreakerActive: cbActive,
    circuitBreakerUntil: state.circuitBreakerUntil,
    lastUpdated:         state.lastUpdated,
  };
}

export function getOpenPaperPositions(): PaperTrade[] {
  return loadPaperTrades().filter((t) => t.status === 'active' || t.status === 'pending');
}

/**
 * Hard-reset the paper trading account.
 * Closes all open positions immediately (no P&L recorded), wipes trade history,
 * and restores the virtual balance to the configured starting balance.
 */
export async function resetPaperTrading(): Promise<number> {
  // Set synchronously before acquiring the lock.  Any concurrent
  // checkPaperPositions or enterPaperTrade that is mid-execution (currently
  // awaiting a price fetch inside the lock) will see this flag when it resumes
  // and will skip its stale in-memory writes, preventing it from overwriting
  // the fresh state we are about to save.
  resetInProgress = true;
  try {
    return await withStateLock(async () => {
      ensureDataDir();
      const startingBalance = config.paper.startingBalance;
      savePaperTrades([]);
      // Explicitly clear blown/circuit-breaker flags so the account is
      // fully unblocked regardless of what state it was in before the reset
      const freshState: PaperState = {
        virtualBalance:      startingBalance,
        startingBalance,
        lastUpdated:         new Date().toISOString(),
        consecutiveLosses:   0,
        blownAt:             undefined,
        circuitBreakerUntil: undefined,
      };
      savePaperState(freshState);
      logger.info(`[paperTrading] Account reset — balance restored to $${startingBalance.toFixed(2)}, all trade history wiped`);
      return startingBalance;
    });
  } finally {
    resetInProgress = false; // always clear, even on error
    // Also reset notification timers so the next block (if any) notifies promptly
    lastBlownNotifTime = 0;
    lastCBNotifTime    = 0;
  }
}

export function getPaperHistory(count: number): PaperTrade[] {
  const trades = loadPaperTrades().filter((t) => t.status === 'closed');
  return trades.slice(-count).reverse();
}

export function getTodayPaperTrades(): PaperTrade[] {
  const today = new Date().toISOString().slice(0, 10);
  return loadPaperTrades().filter(
    (t) => t.status === 'closed' && (t.closeTime ?? '').slice(0, 10) === today
  );
}

export function getPaperTradesByPeriod(period: 'daily' | 'weekly' | 'all'): PaperTrade[] {
  const trades = loadPaperTrades().filter((t) => t.status === 'closed');
  if (period === 'all') return trades;
  if (period === 'daily') {
    const today = new Date().toISOString().slice(0, 10);
    return trades.filter((t) => (t.closeTime ?? '').slice(0, 10) === today);
  }
  // weekly
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return trades.filter((t) => t.closeTime && new Date(t.closeTime).getTime() >= weekAgo);
}

export function getPaperBalanceJourney(): { starting: number; peak: number; current: number } {
  const state  = loadPaperState();
  const trades = loadPaperTrades().filter((t) => t.status === 'closed');
  let peak    = state.startingBalance;
  let running = state.startingBalance;
  for (const t of trades) {
    running += t.pnlDollar ?? 0;
    if (running > peak) peak = running;
  }
  return { starting: state.startingBalance, peak, current: state.virtualBalance };
}

// ─── Scheduled report embeds ──────────────────────────────────────────────────

export function buildPaperHeartbeatEmbed() {
  const state  = loadPaperState();
  const trades = loadPaperTrades();
  const open    = trades.filter((t) => t.status === 'active');
  const pending = trades.filter((t) => t.status === 'pending');
  const today   = new Date().toISOString().slice(0, 10);
  const todayClosed = trades.filter(
    (t) => t.status === 'closed' && (t.closeTime ?? '').slice(0, 10) === today
  );
  const todayWins = todayClosed.filter((t) => (t.pnlDollar ?? 0) > 0);
  const todayPnl  = todayClosed.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
  const balanceDiff = state.virtualBalance - state.startingBalance;
  const balanceSign = balanceDiff >= 0 ? '+' : '';
  const pnlSign     = todayPnl >= 0 ? '+' : '';

  const cbActive = !!(
    state.circuitBreakerUntil &&
    Date.now() < new Date(state.circuitBreakerUntil).getTime()
  );

  const openLines = open.slice(0, 8).map((t) => {
    const dir = t.direction === 'LONG' ? '🟢' : '🔴';
    const asset = t.asset.split('/')[0];
    const unrealPct = t.currentPrice && t.entryPrice
      ? ((t.direction === 'LONG'
          ? (t.currentPrice - t.entryPrice)
          : (t.entryPrice - t.currentPrice)) / t.entryPrice * 100).toFixed(1)
      : '—';
    return `${dir} ${asset} ${unrealPct}%`;
  });
  if (open.length > 8) openLines.push(`…+${open.length - 8} more`);

  const embed = new EmbedBuilder()
    .setColor(todayPnl >= 0 ? 0x00c8ff : 0xff9944)
    .setTitle('🕛 Paper Trading Midday Check-in')
    .addFields(
      {
        name: '💰 Account',
        value: [
          `Balance: **$${state.virtualBalance.toFixed(2)}** (${balanceSign}$${balanceDiff.toFixed(2)} all-time)`,
          `Starting: $${state.startingBalance.toFixed(2)}`,
          cbActive ? `⚠️ Circuit breaker active until ${state.circuitBreakerUntil!.slice(11, 16)} UTC` : '',
        ].filter(Boolean).join('\n'),
        inline: false,
      },
      {
        name: `📊 Today So Far (${todayClosed.length} closed)`,
        value: todayClosed.length === 0
          ? 'No closed trades yet today.'
          : [
              `W: ${todayWins.length} / L: ${todayClosed.length - todayWins.length}`,
              `Net P&L: **${pnlSign}$${todayPnl.toFixed(2)}**`,
              `Win rate: ${((todayWins.length / todayClosed.length) * 100).toFixed(0)}%`,
            ].join(' · '),
        inline: false,
      },
      {
        name: `📂 Open (${open.length}) + Pending (${pending.length})`,
        value: open.length === 0 && pending.length === 0
          ? 'No open positions.'
          : [
              ...openLines,
              pending.length > 0 ? `⏳ ${pending.length} pending order(s) waiting to fill` : '',
            ].filter(Boolean).join('\n'),
        inline: false,
      }
    )
    .setTimestamp()
    .setFooter({ text: 'Midnight UTC: full daily report · /paper-status for live stats' });

  return { embeds: [embed] };
}

export function buildDailyPaperReportEmbed(date: string) {
  const trades = loadPaperTrades().filter(
    (t) => t.status === 'closed' &&
           (t.closeTime ?? '').slice(0, 10) === date &&
           t.closeReason !== 'pending expired'
  );
  const state    = loadPaperState();
  const wins     = trades.filter((t) => (t.pnlDollar ?? 0) > 0);
  const losses   = trades.filter((t) => (t.pnlDollar ?? 0) <= 0);
  const netPnl   = trades.reduce((s, t) => s + (t.pnlDollar ?? 0), 0);
  const bestTrade = trades.reduce<PaperTrade | null>((best, t) =>
    best === null || (t.pnlDollar ?? 0) > (best.pnlDollar ?? 0) ? t : best, null);
  const worstTrade = trades.reduce<PaperTrade | null>((worst, t) =>
    worst === null || (t.pnlDollar ?? 0) < (worst.pnlDollar ?? 0) ? t : worst, null);

  const stratStats: Record<string, { pnl: number; count: number }> = {};
  for (const t of trades) {
    if (!stratStats[t.strategy]) stratStats[t.strategy] = { pnl: 0, count: 0 };
    stratStats[t.strategy].pnl   += t.pnlDollar ?? 0;
    stratStats[t.strategy].count += 1;
  }
  const bestStrategy = Object.entries(stratStats)
    .sort((a, b) => b[1].pnl - a[1].pnl)[0]?.[0] ?? 'N/A';

  const isProfit = netPnl >= 0;
  const embed = new EmbedBuilder()
    .setColor(trades.length === 0 ? 0x5865f2 : isProfit ? 0x00ff87 : 0xff4444)
    .setTitle(`📊 Daily Paper Trading Report — ${date}`)
    .addFields(
      {
        name: '📈 Today\'s Trades',
        value: trades.length === 0
          ? 'No paper trades today.'
          : [
              `Trades: **${trades.length}** (W: ${wins.length} / L: ${losses.length})`,
              `Net P&L: **${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}**`,
              bestTrade  ? `Best: ${bestTrade.asset.split('/')[0]} **+$${(bestTrade.pnlDollar ?? 0).toFixed(2)}**` : '',
              worstTrade ? `Worst: ${worstTrade.asset.split('/')[0]} **$${(worstTrade.pnlDollar ?? 0).toFixed(2)}**` : '',
            ].filter(Boolean).join('\n'),
        inline: false,
      },
      {
        name: '💰 Balance',
        value: [
          `Current: **$${state.virtualBalance.toFixed(2)}**`,
          `Starting: $${state.startingBalance.toFixed(2)}`,
          `Best Strategy: ${bestStrategy}`,
          state.consecutiveLosses ? `Current loss streak: ${state.consecutiveLosses}` : '',
        ].filter(Boolean).join('\n'),
        inline: false,
      }
    )
    .setTimestamp()
    .setFooter({ text: 'Use /paper-performance for full breakdown' });

  return { embeds: [embed] };
}
