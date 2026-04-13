import cron from 'node-cron';
import type { TextChannel } from 'discord.js';
import { discordClient } from './bot/client';
import { fetchAllAssets, fetchOHLCV, fetchCurrentPrice } from './data/marketData';
import { checkPaperPositions, enterPaperTrade, buildDailyPaperReportEmbed, buildPaperHeartbeatEmbed } from './paper/paperTrading';
import { initializeTopCryptos, refreshTopCryptos, verifyAssets } from './data/topCryptos';
import { postDailyPaperReport } from './paper/dailyReport';
import { detectRegime, isTradeableRegime, setLastRegime, getLastRegimes } from './regime/regimeDetector';
import { TrendPullbackStrategy } from './strategies/trendPullback';
import { BreakoutRetestStrategy } from './strategies/breakoutRetest';
import { LiquiditySweepStrategy } from './strategies/liquiditySweep';
import { VolatilityExpansionStrategy } from './strategies/volatilityExpansion';
import { SwingStrategy } from './strategies/swing';
import { ScalpFVGStrategy } from './strategies/scalpFVG';
import {
  applyAdaptationWeight,
  filterAndRankSignals,
  deduplicateSignals,
} from './scoring/votingEngine';
import {
  addPendingSignal,
  getAllActivePositions,
  isDuplicateSignal,
  markSignalSent,
  updateDynamicSLTP,
  handleSLTPHit,
  attemptMomentumTPExtension,
} from './signals/signalManager';
import { analyseMarketStructure } from './analysis/marketStructure';
import { findAreasOfValue, isPriceInZone } from './analysis/areaOfValue';
import { checkHardControls, getStrategyWeight, getMinScoreThreshold } from './adaptation/adaptation';
import { loadScalpParams, ensureScalpParamsExist, resetStaleScalpParams } from './paper/scalpParams';
import { postWeeklyScalpReport } from './paper/weeklyReport';
import {
  buildSignalEmbed,
  buildTPUpdateEmbed,
  buildExitAlertEmbed,
  buildClosedTradeEmbed,
  buildEarlyProfitAlertEmbed,
  buildPositionHealthEmbed,
  buildSummaryEmbed,
} from './bot/embeds';
import { generateDailySummary } from './llm/summaries';
import { cachedRsi, cachedEma, cachedVwap } from './indicators/cache';
import { volumeAverage } from './indicators/indicators';
import { config } from './config';
import { logger } from './utils/logger';
import type { Asset, MultiTimeframeData, RegimeResult, StrategySignal } from './types';

// ─── Paper channel helper ─────────────────────────────────────────────────────
// All paper trade notifications (entries, exits, reports) go to #paper-trading.
// Falls back to signalChannelId if paperChannelId is not yet set (e.g. startup race).
async function getPaperChannel(): Promise<TextChannel | null> {
  const id = config.discord.paperChannelId || config.discord.signalChannelId;
  if (!id) return null;
  const ch = await discordClient.channels.fetch(id).catch(() => null);
  return ch?.isTextBased() ? (ch as TextChannel) : null;
}

// Capital-return milestones that trigger profit alerts (fraction of capital).
// Each milestone fires once and independently — positions get 1–4 profit pings through a big move.
const PROFIT_MILESTONES = [0.25, 0.75, 1.50, 3.00]; // 25%, 75%, 150%, 300%

// Position health checks fire on two independent triggers:
//   TIME:  at least every 15 minutes regardless of price action
//   PRICE: whenever spot moves ≥1% from the last update price
// A 5-minute minimum gap between updates prevents spam on fast-moving candles.
const HEALTH_PRICE_TRIGGER_PCT = 0.01;          // 1% spot move
const HEALTH_TIME_TRIGGER_MS  = 15 * 60 * 1000; // 15-minute periodic check
const HEALTH_MIN_GAP_MS       =  5 * 60 * 1000; // spam guard

const strategies = [
  new TrendPullbackStrategy(),
  new BreakoutRetestStrategy(),
  new LiquiditySweepStrategy(),
  new VolatilityExpansionStrategy(),
  new SwingStrategy(),
  new ScalpFVGStrategy(),
];

// Strategies that are scalp-oriented and should bypass the swing quality gate.
// The swing gate (HTF bias + zone confluence) is a SWING concept — applying it
// to scalp strategies over-filters signals that are valid at the 1m/5m level.
const SCALP_STRATEGIES = new Set(['Scalp FVG', 'Trend Pullback', 'Breakout Retest', 'Liquidity Sweep', 'Volatility Expansion']);

/**
 * Swing-first quality gate — applied to every signal before posting.
 *
 * Ensures that even non-Swing strategy signals are only posted when:
 *  1. HTF bias (W/D/4H market structure) agrees with the signal direction.
 *  2. Price is currently inside a valid area of value (≥2 confluence criteria).
 *
 * SwingStrategy signals already pass this check internally, so they are
 * allowed through unconditionally (avoids re-running the same analysis).
 *
 * SCALP/HYBRID signals bypass this gate entirely — the gate is calibrated for
 * swing timeframes (daily/4h) and would massively over-filter scalp entries.
 * The scalp_params.json bypassSwingGateForScalps flag controls this.
 */
function passesSwingQualityGate(signal: StrategySignal, mtfData: MultiTimeframeData): boolean {
  if (signal.strategy === 'Swing') return true; // already validated internally

  // Scalp/Hybrid bypass — read from live scalp params
  if (signal.tradeType === 'SCALP' || signal.tradeType === 'HYBRID') {
    const params = loadScalpParams();
    if (params.bypassSwingGateForScalps || SCALP_STRATEGIES.has(signal.strategy)) return true;
  }

  try {
    const bias = analyseMarketStructure(mtfData['1w'], mtfData['1d'], mtfData['4h']);
    if (bias.confidence === 'LOW' || bias.direction === null) return false;
    if (bias.direction !== signal.direction) return false;

    const currentPrice = mtfData['4h'][mtfData['4h'].length - 1]?.close;
    if (!currentPrice) return false;

    const isLong = signal.direction === 'LONG';
    const zones = findAreasOfValue(mtfData['1w'], mtfData['1d'], mtfData['4h'], currentPrice, isLong);
    const qualifiedZones = zones.filter((z) => z.confluenceScore >= 2);
    return qualifiedZones.some((z) => isPriceInZone(currentPrice, z));
  } catch {
    return false; // fail closed — don't post if gate errors
  }
}

// ─── Last scan summary (read by /status) ─────────────────────────────────────

export interface LastScanSummary {
  timestamp: number;
  assetResults: { asset: string; regime: string; topScore: number | null; topStrategy: string | null }[];
  rawSignals: number;
  rankedSignals: number;
  postedSignals: number;
  skipped: boolean;
  skipReason?: string;
}

let _lastScanSummary: LastScanSummary | null = null;
export function getLastScanSummary(): LastScanSummary | null { return _lastScanSummary; }

// ─── Single-asset scan (used by /check, /watchlist, /live) ───────────────────

export interface SingleAssetScanResult {
  asset: string;
  regime: RegimeResult | null;
  signals: StrategySignal[];  // all signals from all strategies (any tier)
  error?: string;
}

export async function scanSingleAsset(symbol: string): Promise<SingleAssetScanResult> {
  try {
    const asset = symbol as Asset;
    const [candles1w, candles1d, candles4h, candles15m, candles5m, candles1m] = await Promise.all([
      fetchOHLCV(asset, '1w'),
      fetchOHLCV(asset, '1d'),
      fetchOHLCV(asset, '4h', 200),
      fetchOHLCV(asset, '15m', 200),
      fetchOHLCV(asset, '5m', 200),
      fetchOHLCV(asset, '1m', 200),
    ]);
    const mtfData: MultiTimeframeData = {
      asset,
      '1w':  candles1w,
      '1d':  candles1d,
      '4h':  candles4h,
      '15m': candles15m,
      '5m':  candles5m,
      '1m':  candles1m,
    };
    const regime = detectRegime(asset, candles4h);
    setLastRegime(asset, regime);

    const signals: StrategySignal[] = [];
    for (const strategy of strategies) {
      try {
        let signal = strategy.analyze(mtfData, regime.regime);
        if (!signal) continue;
        signal = { ...signal, asset };
        const weight = getStrategyWeight(strategy.name);
        signal = applyAdaptationWeight(signal, weight);
        if (!passesSwingQualityGate(signal, mtfData)) continue;
        signals.push(signal);
      } catch {
        // skip failing strategies silently
      }
    }
    return { asset: symbol, regime, signals };
  } catch (err) {
    return { asset: symbol, regime: null, signals: [], error: String(err) };
  }
}

// ─── Signal posting ───────────────────────────────────────────────────────────

async function postSignal(signal: StrategySignal) {
  // ── Channel routing ─────────────────────────────────────────────────────────
  // #bot-signals  → SWING and HYBRID only (manual trading channel — keep it clean)
  // #paper-trading → ALL signals auto-entered silently (scalp, hybrid, swing)
  //
  // Scalp signals are too fast for manual entry and would spam #bot-signals,
  // so they go straight to paper trading without a Discord post.
  const isSwingOrHybrid = signal.tradeType === 'SWING' || signal.tradeType === 'HYBRID';

  if (isSwingOrHybrid) {
    const channel = await discordClient.channels.fetch(config.discord.signalChannelId);
    if (!channel) {
      logger.error(`postSignal: channel ${config.discord.signalChannelId} not found`);
    } else if (!channel.isTextBased()) {
      logger.error(`postSignal: channel ${config.discord.signalChannelId} is not a text channel`);
    } else {
      await (channel as TextChannel).send(buildSignalEmbed(signal));
      addPendingSignal(signal);
      markSignalSent(signal);
      logger.info(`Signal posted to #bot-signals: ${signal.asset} ${signal.direction} [${signal.tradeType}] score=${signal.score} [${signal.tier}]`);
    }
  } else {
    // SCALP — register internally so dedup works, but no Discord post to #bot-signals
    markSignalSent(signal);
    logger.info(`Scalp signal (paper-only): ${signal.asset} ${signal.direction} score=${signal.score} [${signal.tier}]`);
  }

  // Auto-enter paper trade for ALL signal types — notifications → #paper-trading
  if (config.paper.enabled) {
    try {
      // Fetch live price for realistic entry simulation.
      // Falls back to entryZone midpoint if the price fetch fails (e.g. market closed).
      // For SCALP signals, paperTrading.ts will use signal.entryZone[0] as the limit
      // price regardless — the currentPrice here is only used for SWING/HYBRID
      // immediate entries and for metadata capture.
      const currentPrice = await fetchCurrentPrice(signal.asset as Asset).catch(
        () => (signal.entryZone[0] + signal.entryZone[1]) / 2
      );
      const paperCh = await getPaperChannel();
      if (paperCh) {
        await enterPaperTrade(signal, currentPrice, paperCh);
      }
    } catch (err) {
      logger.warn('Paper trade entry failed:', err);
    }
  }
}

// ─── Position monitoring ──────────────────────────────────────────────────────

async function monitorActivePositions() {
  const positions = getAllActivePositions();
  if (positions.length === 0) return;

  for (const position of positions) {
    try {
      const asset = position.signal.asset as Asset;
      const [candles5m, candles15m, currentPrice] = await Promise.all([
        fetchOHLCV(asset, '5m'),
        fetchOHLCV(asset, '15m'),
        fetchCurrentPrice(asset),
      ]);

      // ── Profit milestone alerts ───────────────────────────────────────
      // ALL exceeded milestones fire in a single cycle — no one-per-cycle drip.
      // firedMilestones is a Set stored as an array for JSON serialisation.
      // Falls back to legacy lastProfitMilestonePct for positions saved before this update.
      const isLong = position.signal.direction === 'LONG';
      const priceMoved = isLong
        ? (currentPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - currentPrice) / position.entryPrice;
      const capitalReturn = priceMoved * position.suggestedLeverage;

      const alreadyFired = new Set<number>(
        position.firedMilestones ??
        (() => {
          // Migrate legacy field — validate it's actually a number before using
          const legacy = position.lastProfitMilestonePct;
          return (typeof legacy === 'number' && isFinite(legacy))
            ? PROFIT_MILESTONES.filter(m => m <= legacy)
            : [];
        })()
      );
      const toFire = PROFIT_MILESTONES.filter(m => !alreadyFired.has(m) && capitalReturn >= m);
      if (toFire.length > 0) {
        for (const milestone of toFire) {
          alreadyFired.add(milestone);
          const profitChannel = await discordClient.channels.fetch(position.channelId).catch(() => null);
          if (profitChannel?.isTextBased()) {
            await (profitChannel as TextChannel).send(
              buildEarlyProfitAlertEmbed(position, currentPrice, capitalReturn, milestone)
            );
          } else {
            logger.warn(`Milestone alert dropped — channel ${position.channelId} not found for position ${position.id}`);
          }
        }
        position.firedMilestones = [...alreadyFired].sort((a, b) => a - b);
      }

      // ── Position health check ─────────────────────────────────────────────
      // Fires when: (a) 15 min have passed since last check (periodic), OR
      //             (b) price has moved ≥1% since the last update (price-triggered).
      // A 5-minute minimum gap prevents spam on fast-moving candles.
      const refPrice = position.lastHealthUpdatePrice ?? position.entryPrice;
      const priceMoveSinceUpdate = Math.abs(currentPrice - refPrice) / refPrice;
      const timeSinceUpdate = Date.now() - (position.lastHealthUpdateAt ?? 0);

      const timeTriggered  = timeSinceUpdate >= HEALTH_TIME_TRIGGER_MS;
      const priceTriggered = priceMoveSinceUpdate >= HEALTH_PRICE_TRIGGER_PCT
                             && timeSinceUpdate >= HEALTH_MIN_GAP_MS;

      if (timeTriggered || priceTriggered) {
        try {
          const rsiVals5m  = cachedRsi(candles5m, 14);
          const ema9Vals   = cachedEma(candles5m, 9);
          const vwapVals   = cachedVwap(candles5m);
          const rsi14      = rsiVals5m[rsiVals5m.length - 1] ?? NaN;
          const ema9       = ema9Vals[ema9Vals.length - 1] ?? NaN;
          const vwap       = vwapVals[vwapVals.length - 1] ?? NaN;

          // RSI slope: compare current RSI to 3 bars ago
          const rsiPrev3   = rsiVals5m[rsiVals5m.length - 4] ?? NaN;
          const rsiSlope: 'rising' | 'flat' | 'falling' =
            !isNaN(rsi14) && !isNaN(rsiPrev3)
              ? rsi14 - rsiPrev3 > 2 ? 'rising' : rsiPrev3 - rsi14 > 2 ? 'falling' : 'flat'
              : 'flat';

          // Volume ratio
          const avgVol     = volumeAverage(candles5m, 20);
          const lastVol    = candles5m[candles5m.length - 1]?.volume ?? 0;
          const volumeRatio = avgVol > 0 ? lastVol / avgVol : undefined;

          // 15m EMA(21)
          const ema21Vals15m = cachedEma(candles15m, 21);
          const ema21_15m    = ema21Vals15m[ema21Vals15m.length - 1] ?? NaN;

          // Skip health embed if core 5m indicators are both unavailable
          if (isNaN(rsi14) && isNaN(ema9)) {
            logger.warn(`Health check skipped for ${asset} — insufficient candle data for indicators`);
          } else {
            position.lastHealthUpdatePrice = currentPrice;
            position.lastHealthUpdateAt = Date.now();

            const healthChannel = await discordClient.channels.fetch(position.channelId).catch(() => null);
            if (healthChannel?.isTextBased()) {
              await (healthChannel as TextChannel).send(
                buildPositionHealthEmbed(position, currentPrice,
                  { rsi14, ema9, rsiSlope, ema21_15m, vwap, volumeRatio },
                  timeTriggered && !priceTriggered ? 'TIME' : 'PRICE')
              );
            } else {
              logger.warn(`Health update dropped — channel ${position.channelId} not found for position ${position.id}`);
            }
          }
        } catch (healthErr) {
          logger.warn(`Health update failed for position ${position.id}:`, healthErr);
        }
      }

      // ── Regime-flip gate ─────────────────────────────────────────────────
      // If the 4H regime has changed since entry, TP extensions are paused.
      // SL trailing still runs (capital protection), but we stop pushing TP
      // further when the market structure that justified this trade is gone.
      // If regime is unknown (first cycle after restart), allow extensions —
      // the next scan cycle will populate the cache and the gate activates then.
      const cachedRegime = getLastRegimes().get(asset);
      if (cachedRegime === undefined) {
        logger.debug(`${asset} regime not yet cached — TP extension gate deferred until first scan`);
      }
      const regimeFlipped = cachedRegime !== undefined && cachedRegime.regime !== position.signal.regime;
      if (regimeFlipped) {
        logger.warn(
          `${asset} regime flipped ${position.signal.regime} → ${cachedRegime!.regime} ` +
          `— TP extensions paused for position ${position.id}`
        );
      }

      const update = updateDynamicSLTP(position, candles5m, currentPrice, !regimeFlipped);
      if (!update) continue;

      const channel = await discordClient.channels.fetch(position.channelId);
      if (!channel?.isTextBased()) continue;
      const tc = channel as TextChannel;

      // ── TP hit ───────────────────────────────────────────────────────────
      if (update.hitTP) {
        await tc.send(buildExitAlertEmbed(position, 'TP_HIT', currentPrice));

        const trade = handleSLTPHit(update);
        if (trade) {
          await tc.send(buildClosedTradeEmbed(trade));
        }
        continue;
      }

      // ── TP level extended ────────────────────────────────────────────────
      if (update.oldTP !== update.newTP) {
        await tc.send(
          buildTPUpdateEmbed(
            position,
            update.oldTP,
            update.newTP,
            currentPrice
          )
        );
      }

      // ── TP proximity: momentum check at 1% out (was 0.3%) ──────────────
      // Firing at 1% gives the momentum evaluation meaningful lead time
      // rather than checking only when price is already at the doorstep.
      // Skipped entirely if the regime has flipped.
      const tpDist = Math.abs(currentPrice - update.newTP) / currentPrice;
      if (tpDist < 0.010 && !regimeFlipped) {
        const extension = attemptMomentumTPExtension(position, candles5m, currentPrice);
        if (extension) {
          // Momentum is strong — push TP out and let it run
          await tc.send(buildTPUpdateEmbed(position, extension.oldTP, extension.newTP, currentPrice));
        } else {
          // Momentum is fading or cap reached — alert to consider taking profit
          await tc.send(buildExitAlertEmbed(position, 'TP_APPROACH', currentPrice));
        }
      }
    } catch (err) {
      logger.error(`Error monitoring position ${position.id}:`, err);
    }
  }
}

// ─── Main scan loop ───────────────────────────────────────────────────────────

export async function runScanCycle(): Promise<{ signalCount: number; skipped: boolean; reason?: string }> {
  const guard = checkHardControls();
  if (!guard.allowed) {
    logger.info(`Scan skipped: ${guard.reason}`);
    _lastScanSummary = { timestamp: Date.now(), assetResults: [], rawSignals: 0, rankedSignals: 0, postedSignals: 0, skipped: true, skipReason: guard.reason };
    return { signalCount: 0, skipped: true, reason: guard.reason };
  }

  logger.info('Starting scan cycle...');

  try {
    // 1. Monitor active positions first (most time-sensitive)
    await monitorActivePositions();

    // 2. Fetch all asset data
    let allData: MultiTimeframeData[];
    try {
      allData = await fetchAllAssets();
    } catch (err) {
      logger.error('Data fetch failed:', err);
      return { signalCount: 0, skipped: false };
    }

    const newSignals: any[] = [];
    const assetResults: LastScanSummary['assetResults'] = [];

    // Read adaptive scalp params once per cycle
    const scalpParams = loadScalpParams();

    for (const mtfData of allData) {
      const asset = mtfData.asset;
      const regime = detectRegime(asset, mtfData['4h']);
      setLastRegime(asset, regime);

      // Asset weight check — skip under-performing assets (scalp params)
      const assetWeight = scalpParams.assetWeights[asset] ?? 1.0;
      if (assetWeight <= 0) {
        logger.info(`${asset}: weight=0 (suppressed by scalp params) — skipping`);
        assetResults.push({ asset, regime: regime.regime, topScore: null, topStrategy: null });
        continue;
      }

      // Scalp strategies can run in any regime — only swing strategies need tradeable regime
      const isScalpOnly = strategies.every((s) => SCALP_STRATEGIES.has(s.name));
      if (!isTradeableRegime(regime.regime) && !isScalpOnly) {
        logger.info(`${asset}: ${regime.regime} — non-scalp strategies skipping`);
      }

      logger.info(`${asset}: ${regime.regime} (ADX=${regime.adx.toFixed(1)}, ATRx=${regime.atrRatio.toFixed(2)}, assetWeight=${assetWeight.toFixed(2)})`);

      let assetTopScore: number | null = null;
      let assetTopStrategy: string | null = null;

      // Run each strategy
      for (const strategy of strategies) {
        try {
          // Scalp FVG works in any regime; other strategies still need tradeable regime
          const isScalpStrategy = SCALP_STRATEGIES.has(strategy.name) && strategy.name !== 'Scalp FVG'
            ? false  // non-FVG scalp strategies still need tradeable regime for their logic
            : strategy.name === 'Scalp FVG';

          if (!isTradeableRegime(regime.regime) && !isScalpStrategy) {
            logger.info(`  ${strategy.name}: skipping — ${regime.regime} not tradeable`);
            continue;
          }

          let signal = strategy.analyze(mtfData, regime.regime);
          if (!signal) {
            logger.info(`  ${strategy.name}: no setup detected`);
            continue;
          }

          // Fix asset on signals that use placeholder
          signal = { ...signal, asset };

          // Apply adaptation weights: scalp params strategy weight × adaptation weight
          const adaptWeight   = getStrategyWeight(strategy.name);
          const scalpWeight   = scalpParams.strategyWeights[strategy.name] ?? 1.0;
          const combinedWeight = adaptWeight * scalpWeight;
          const preWeightScore = signal.score;
          signal = applyAdaptationWeight(signal, combinedWeight);

          const weightNote = combinedWeight < 1.0
            ? ` [w=${combinedWeight.toFixed(2)}, score ${preWeightScore}→${signal.score}]`
            : '';

          // Score threshold:
          // • SWING   → manual filter floor (set by /filter command)
          // • SCALP/HYBRID → adaptive scalp-params threshold, but the manual
          //   filter acts as a global floor so /filter strict also gates
          //   paper-only scalp signals that appear in #paper-trading.
          const isScalpSignal = signal.tradeType === 'SCALP' || signal.tradeType === 'HYBRID';
          const manualFloor = getMinScoreThreshold();
          const minScore = isScalpSignal
            ? Math.max(
                signal.tradeType === 'SCALP' ? scalpParams.minScoreScalp : scalpParams.minScoreHybrid,
                manualFloor
              )
            : manualFloor;

          if (signal.score < minScore || signal.tier === 'NO_TRADE') {
            logger.info(`  ${strategy.name}: score=${signal.score} < ${minScore}${weightNote} — filtered`);
            continue;
          }
          if (!passesSwingQualityGate(signal, mtfData)) {
            logger.info(`  ${strategy.name}: score=${signal.score} [${signal.tier}]${weightNote} ${signal.direction} — swing gate rejected`);
            continue;
          }
          if (isDuplicateSignal(signal)) {
            logger.info(`  ${strategy.name}: score=${signal.score} [${signal.tier}]${weightNote} ${signal.direction} — duplicate suppressed`);
            continue;
          }

          logger.info(`  ${strategy.name}: score=${signal.score} [${signal.tier}]${weightNote} ${signal.direction} ✓ queued`);
          newSignals.push(signal);
          if (assetTopScore === null || signal.score > assetTopScore) {
            assetTopScore = signal.score;
            assetTopStrategy = strategy.name;
          }
        } catch (err) {
          logger.error(`Strategy ${strategy.name} error for ${asset}:`, err);
        }
      }
      assetResults.push({ asset, regime: regime.regime, topScore: assetTopScore, topStrategy: assetTopStrategy });
    }

    // Signals in newSignals already passed their per-type threshold filter above
    // (scalpParams.minScoreScalp for SCALP, getMinScoreThreshold() for SWING/HYBRID).
    // Pass 0 here so we only sort/dedup — not re-filter with a possibly different
    // global threshold that would silently drop valid SCALP signals.
    const ranked = filterAndRankSignals(newSignals, 0);
    const deduped = deduplicateSignals(ranked);

    logger.info(`Scan complete: ${newSignals.length} raw → ${ranked.length} ranked → ${deduped.length} posted`);
    _lastScanSummary = {
      timestamp: Date.now(),
      assetResults,
      rawSignals: newSignals.length,
      rankedSignals: ranked.length,
      postedSignals: deduped.length,
      skipped: false,
    };

    let postedCount = 0;
    for (const signal of deduped) {
      try {
        await postSignal(signal);
        postedCount++;
      } catch (err) {
        logger.error(`Failed to post signal for ${signal.asset} ${signal.direction}:`, err);
      }
    }

    return { signalCount: postedCount, skipped: false };
  } catch (err) {
    logger.error('Scan cycle error:', err);
    return { signalCount: 0, skipped: false };
  }
}

// ─── Daily summary cron ──────────────────────────────────────────────────────

async function postDailySummary() {
  logger.info('Generating daily summary...');

  const channelId = config.discord.summaryChannelId;
  if (!channelId) {
    logger.warn('postDailySummary: SUMMARY_CHANNEL_ID is not configured — set it in .env to receive daily summaries');
    return;
  }

  try {
    const result = await generateDailySummary();
    const channel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      logger.error(`postDailySummary: could not fetch channel ${channelId} — check SUMMARY_CHANNEL_ID`);
      return;
    }
    if (!channel.isTextBased()) {
      logger.error(`postDailySummary: channel ${channelId} is not a text channel`);
      return;
    }
    await (channel as TextChannel).send(buildSummaryEmbed('daily', result.stats, result.aiText, result.label));
    logger.info(`Daily summary posted (${result.stats.totalTrades} trades, ${(result.stats.winRate * 100).toFixed(0)}% WR)`);
  } catch (err) {
    logger.error('Daily summary error:', err);
  }
}

// ─── Schedule setup ───────────────────────────────────────────────────────────

export function startScheduler() {
  // Initialise hardcoded asset list (synchronous — no network call)
  initializeTopCryptos();

  // Verify all hardcoded crypto assets are reachable on the exchange.
  // Non-blocking — runs async in background so startup is not delayed.
  // Results are logged; unavailable symbols are skipped gracefully at scan time.
  verifyAssets().catch((err) => logger.warn('[assetVerify] Verification error:', err));

  // Reset stale scalp_params.json if it has old aggressive thresholds, then ensure file exists
  resetStaleScalpParams();
  ensureScalpParamsExist();

  const interval = config.engine.scanIntervalMinutes;
  logger.info(`Starting scan scheduler: every ${interval} min`);

  // Main scan: every N minutes
  // Cron minutes field only accepts 0-59; use setInterval for intervals >= 60
  if (interval < 60) {
    cron.schedule(`*/${interval} * * * *`, () => {
      runScanCycle().catch((err) => logger.error('Unhandled scan error:', err));
    });
  } else {
    const intervalMs = interval * 60 * 1000;
    setInterval(() => {
      runScanCycle().catch((err) => logger.error('Unhandled scan error:', err));
    }, intervalMs);
    logger.info(`Using setInterval for ${interval}-minute scan cadence`);
  }

  // Weekly scalp analysis: every Sunday at midnight UTC — posts to #paper-trading
  cron.schedule('0 0 * * 0', () => {
    getPaperChannel()
      .then((ch) => {
        if (ch) {
          postWeeklyScalpReport(ch)
            .catch((err) => logger.error('Weekly scalp report error:', err));
        }
      })
      .catch((err) => logger.error('Weekly scalp report channel fetch error:', err));
  });

  // Noon UTC check-in: lightweight midday heartbeat → #paper-trading
  // Shows live balance, open positions, and today's P&L so far without waiting until midnight.
  cron.schedule('0 12 * * *', () => {
    getPaperChannel()
      .then((ch) => {
        if (ch) {
          ch.send(buildPaperHeartbeatEmbed())
            .catch((err) => logger.error('Paper noon heartbeat error:', err));
        }
      })
      .catch((err) => logger.error('Paper noon heartbeat channel fetch error:', err));
  });

  // Midnight UTC: daily signal/market summary → #bot-signals
  cron.schedule('0 0 * * *', () => {
    postDailySummary().catch((err) => logger.error('Unhandled summary error:', err));
    refreshTopCryptos(); // no-op for static list, kept for future use
  });

  // 23:59 UTC daily (≈ 7:59 PM EDT / 6:59 PM EST):
  // Full paper trading report for the completed trading day → #paper-trading
  // Saves a .md file and posts it as an attachment so you can paste it into Claude.
  cron.schedule('59 23 * * *', () => {
    getPaperChannel()
      .then((ch) => {
        if (ch) {
          const date = new Date().toISOString().slice(0, 10);
          postDailyPaperReport(ch, date)
            .catch((err) => logger.error('Daily paper report error:', err));
        }
      })
      .catch((err) => logger.error('Daily paper report channel fetch error:', err));
  });

  // Scalp position monitoring — every 90s
  // Scalp position monitoring — every 90s (closes go to #paper-trading)
  const scalpIntervalMs = config.monitoring.scalpIntervalSeconds * 1000;
  setInterval(async () => {
    try {
      const tc = await getPaperChannel();
      if (!tc) return;
      await checkPaperPositions(tc);
    } catch (err) {
      logger.error('Scalp monitoring loop error:', err);
    }
  }, scalpIntervalMs);

  // Swing position monitoring — every 20 min (closes go to #paper-trading)
  const swingIntervalMs = config.monitoring.swingIntervalSeconds * 1000;
  setInterval(async () => {
    try {
      const tc = await getPaperChannel();
      if (!tc) return;
      await checkPaperPositions(tc);
    } catch (err) {
      logger.error('Swing monitoring loop error:', err);
    }
  }, swingIntervalMs);
}
