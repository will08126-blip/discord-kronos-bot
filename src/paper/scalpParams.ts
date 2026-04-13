/**
 * Adaptive Scalp Parameter Store
 *
 * Reads/writes `data/scalp_params.json` — a live-editable file that lets the
 * bot (and the auto-adjuster) tune scalp behaviour without a redeploy.
 *
 * The bot reads these params at the start of every scan cycle.  The
 * auto-adjuster (run weekly) writes updated values.  You can also edit the
 * JSON directly to override anything.
 *
 * Parameter philosophy: START aggressive, let the 7-day analysis narrow in.
 * - Low min score   → more trades → more data → faster learning
 * - High leverage   → bigger moves captured → PF compounds quicker
 * - All regimes     → don't pre-filter, learn which regimes work
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

const PARAMS_FILE = path.join(config.paths.data, 'scalp_params.json');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScalpParams {
  // Signal filtering
  minScoreScalp: number;          // min score to act on a scalp signal (default 35)
  minScoreHybrid: number;         // min score for hybrid signals (default 45)
  bypassSwingGateForScalps: boolean; // skip HTF bias+zone gate for SCALP/HYBRID (default true)
  allowedRegimes: string[];       // regimes where scalp trades are taken

  // Position sizing
  riskPerTradePct: number;        // fraction of virtual balance risked per trade (default 0.02)
  leverageMultiplier: number;     // multiplied on top of calculated leverage (default 1.0)
  maxConcurrentScalps: number;    // max open paper scalp positions (default 5)

  // Dedup & timing
  dedupWindowMinutes: number;     // suppress same-asset signal for N minutes (default 10)
  sessionFilterEnabled: boolean;  // only trade London/NY sessions (default false)
  allowedHoursUTC: number[];      // empty = all hours; populated when sessionFilter enabled

  // Per-asset weight overrides (1.0 = normal, 0.0 = skip)
  assetWeights: Record<string, number>;

  // Per-strategy weight overrides (1.0 = normal, 0.0 = skip)
  strategyWeights: Record<string, number>;

  // Auto-adjustment metadata
  lastAutoAdjust: string;         // ISO timestamp of last auto-adjustment
  adjustmentHistory: AdjustmentRecord[];
}

export interface AdjustmentRecord {
  timestamp: string;
  reason: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// ─── Defaults — AGGRESSIVE STRESS-TEST MODE ──────────────────────────────────
// The user explicitly wants to stress-test the strategy by running it more
// aggressively. Losing the $1,000 is acceptable — the goal is to surface
// weaknesses fast. We lower score gates and dedup windows so more signals
// reach paper trading. #bot-signals (SWING/HYBRID only) stays clean because
// scalp signals never post there regardless of this score gate.

export const DEFAULT_SCALP_PARAMS: ScalpParams = {
  // Score gate: increased to 60 for better signal quality.
  // Fewer signals but higher win rate expected.
  // Hybrid keeps 68 to protect the #bot-signals manual-trading channel.
  minScoreScalp: 60,
  minScoreHybrid: 68,
  bypassSwingGateForScalps: true,
  allowedRegimes: ['TREND_UP', 'TREND_DOWN', 'RANGE', 'VOL_EXPANSION', 'LOW_VOL_COMPRESSION'],

  riskPerTradePct: 0.05,     // aggressive: 5% risk per trade (managed in paperTrading.ts constants)
  leverageMultiplier: 1.0,
  maxConcurrentScalps: 4,    // aggressive: up to 4 concurrent paper positions

  dedupWindowMinutes: 15,    // aggressive: 15min cooldown — re-enter fast after losses

  sessionFilterEnabled: false,
  allowedHoursUTC: [],

  // Asset weights: 0.0 = completely skip this asset.
  // BONK and HYPE ran 0% win rate on day 1. Keep suppressed for now.
  assetWeights: {
    'BONK/USDT': 0,
    'HYPE/USDT': 0,
  },
  strategyWeights: {},

  lastAutoAdjust: new Date(0).toISOString(),
  adjustmentHistory: [],
};

// ─── Load / Save ──────────────────────────────────────────────────────────────

export function loadScalpParams(): ScalpParams {
  try {
    if (fs.existsSync(PARAMS_FILE)) {
      const raw = fs.readFileSync(PARAMS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ScalpParams>;
      // Deep merge: defaults for any missing keys
      return {
        ...DEFAULT_SCALP_PARAMS,
        ...parsed,
        assetWeights: { ...DEFAULT_SCALP_PARAMS.assetWeights, ...(parsed.assetWeights ?? {}) },
        strategyWeights: { ...DEFAULT_SCALP_PARAMS.strategyWeights, ...(parsed.strategyWeights ?? {}) },
        adjustmentHistory: parsed.adjustmentHistory ?? [],
      };
    }
  } catch (e) {
    logger.warn(`scalpParams: could not load ${PARAMS_FILE}, using defaults: ${e}`);
  }
  return { ...DEFAULT_SCALP_PARAMS, assetWeights: {}, strategyWeights: {}, adjustmentHistory: [] };
}

export function saveScalpParams(params: ScalpParams): void {
  try {
    fs.mkdirSync(config.paths.data, { recursive: true });
    const tmp = PARAMS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(params, null, 2));
    fs.renameSync(tmp, PARAMS_FILE);
  } catch (e) {
    logger.error(`scalpParams: failed to save: ${e}`);
  }
}

// ─── Initialise with defaults if file doesn't exist ──────────────────────────

/**
 * Wipe the on-disk scalp_params.json if it contains stale conservative values
 * that conflict with the current aggressive stress-test defaults.
 * This forces a one-time reset without requiring a manual server edit.
 *
 * Stale conditions (conservative values that need to be replaced):
 *   - minScoreScalp > 60  (was raised to 62 after day-1, now lowered back to 55 for stress test)
 *   - maxConcurrentScalps < 4  (was reduced to 2, now back to 4 for stress test)
 *   - dedupWindowMinutes > 20  (was raised to 45, now 15 for aggressive re-entry)
 */
export function resetStaleScalpParams(): void {
  try {
    if (!fs.existsSync(PARAMS_FILE)) return;
    const raw = fs.readFileSync(PARAMS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ScalpParams>;
    // Wipe if these conservative post-day-1 adjustments are still present
    const scoreStale = typeof parsed.minScoreScalp === 'number' && parsed.minScoreScalp > 60;
    const concStale  = typeof parsed.maxConcurrentScalps === 'number' && parsed.maxConcurrentScalps < 4;
    const dedupStale = typeof parsed.dedupWindowMinutes === 'number' && parsed.dedupWindowMinutes > 20;
    if (scoreStale || concStale || dedupStale) {
      fs.unlinkSync(PARAMS_FILE);
      logger.info(
        `scalpParams: reset stale scalp_params.json ` +
        `(score=${parsed.minScoreScalp}, concurrent=${parsed.maxConcurrentScalps}, dedup=${parsed.dedupWindowMinutes}min) ` +
        `— aggressive stress-test defaults will apply on next boot`
      );
    }
  } catch (e) {
    logger.warn(`scalpParams: could not check/reset stale params: ${e}`);
  }
}

export function ensureScalpParamsExist(): void {
  if (!fs.existsSync(PARAMS_FILE)) {
    saveScalpParams({ ...DEFAULT_SCALP_PARAMS, assetWeights: {}, strategyWeights: {}, adjustmentHistory: [] });
    logger.info('scalpParams: created default scalp_params.json');
  }
}

// ─── Auto-adjustment helpers ──────────────────────────────────────────────────

/**
 * Record a single parameter change in the params file.
 * Called by the weekly auto-adjuster to keep a trail of every change.
 */
export function recordAdjustment(
  params: ScalpParams,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  reason: string,
): void {
  const record: AdjustmentRecord = {
    timestamp: new Date().toISOString(),
    reason,
    field,
    oldValue,
    newValue,
  };
  params.adjustmentHistory = [record, ...params.adjustmentHistory].slice(0, 100); // keep last 100
  logger.info(`scalpParams: auto-adjusted ${field}: ${JSON.stringify(oldValue)} → ${JSON.stringify(newValue)} (${reason})`);
}

/**
 * Update per-asset weight.  0.0 = skip asset entirely, 1.0 = normal.
 */
export function setAssetWeight(asset: string, weight: number, reason: string): void {
  const params = loadScalpParams();
  const oldVal = params.assetWeights[asset] ?? 1.0;
  params.assetWeights[asset] = Math.max(0, Math.min(1.5, weight));
  recordAdjustment(params, `assetWeights.${asset}`, oldVal, params.assetWeights[asset], reason);
  params.lastAutoAdjust = new Date().toISOString();
  saveScalpParams(params);
}

/**
 * Update per-strategy weight.
 */
export function setStrategyWeight(strategy: string, weight: number, reason: string): void {
  const params = loadScalpParams();
  const oldVal = params.strategyWeights[strategy] ?? 1.0;
  params.strategyWeights[strategy] = Math.max(0, Math.min(1.5, weight));
  recordAdjustment(params, `strategyWeights.${strategy}`, oldVal, params.strategyWeights[strategy], reason);
  params.lastAutoAdjust = new Date().toISOString();
  saveScalpParams(params);
}

/**
 * Getter helpers used at signal evaluation time.
 */
export function getAssetWeight(asset: string): number {
  const params = loadScalpParams();
  return params.assetWeights[asset] ?? 1.0;
}

export function getStrategyWeightScalp(strategy: string): number {
  const params = loadScalpParams();
  return params.strategyWeights[strategy] ?? 1.0;
}

export function isScalpRegimeAllowed(regime: string): boolean {
  const params = loadScalpParams();
  return params.allowedRegimes.includes(regime);
}
