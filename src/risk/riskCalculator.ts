import type { StrategySignal, TradeType, ScoreTier, Regime } from '../types';
import { config } from '../config';

export interface RiskParameters {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  stopDistancePct: number;      // % distance from entry to SL (internal use only)
  rewardRiskRatio: number;
  suggestedLeverage: number;
  riskPct: number;              // % of your capital to risk (confidence-based)
  tradeType: TradeType;
  deploymentScore: number;      // 0-100: how favourable conditions are to deploy capital
}

/**
 * Confidence-based risk percentages — no fixed capital required.
 * User scales these to whatever they're working with that week.
 *
 * Increased to reflect high-conviction, high-leverage trading style where
 * tight stops (0.3-0.5% for HYBRID) are intentional entry precision rather
 * than wide risk management. Combined with the tight stops this produces
 * leverage suggestions in the 10-40× range for ELITE/STRONG setups.
 */
const RISK_PCT: Record<string, Record<ScoreTier, number>> = {
  scalp:  { ELITE: 5.0, STRONG: 3.0, MEDIUM: 1.5, NO_TRADE: 0 },
  hybrid: { ELITE: 5.0, STRONG: 3.0, MEDIUM: 1.5, NO_TRADE: 0 },
  // Swing trades use larger capital allocation (wide structural stop = lower leverage
  // but larger notional position — e.g. 5% risk / 2% stop = 2.5× notional at 2.5× leverage).
  swing:  { ELITE: 5.0, STRONG: 3.0, MEDIUM: 1.5, NO_TRADE: 0 },
};

// Regime multipliers: adjust risk percentage based on market regime
function getRegimeMultiplier(regime: Regime): number {
  switch (regime) {
    case 'TREND_UP':
    case 'TREND_DOWN':
      return 1.0;
    case 'RANGE':
      return 0.9;
    case 'VOL_EXPANSION':
      return 0.7;
    case 'LOW_VOL_COMPRESSION':
      return 0.8;
    case 'POOR':
      return 0.0; // Should never happen (filtered out earlier)
    default:
      return 1.0;
  }
}

function leverageCap(tier: ScoreTier, tradeType: TradeType): number {
  const typeKey = tradeType === 'SCALP' ? 'scalp' : tradeType === 'HYBRID' ? 'hybrid' : 'swing';
  const tiers = config.leverageTiers[typeKey];
  const byTier = tiers[tier] ?? 5;
  const hardCap = tradeType === 'SCALP'
    ? config.trading.maxLeverageScalp
    : tradeType === 'HYBRID'
    ? config.trading.maxLeverageHybrid
    : config.trading.maxLeverageSwing;
  return Math.min(byTier, hardCap);
}

/**
 * Deployment confidence score (0-100).
 * Measures how favourable the *environment* is to deploy capital right now,
 * based on HTF alignment, momentum, volatility, regime, liquidity and session.
 * Intentionally excludes setupQuality/slippageRisk/recentPerformance — those
 * measure pattern quality (already captured in signal.score).
 */
export function calculateDeploymentScore(signal: StrategySignal): number {
  const c = signal.components;
  const raw =
    c.htfAlignment +   // 0-20
    c.momentum +       // 0-15
    c.volatilityQuality + // 0-10
    c.regimeFit +      // 0-10
    c.liquidity +      // 0-10
    c.sessionQuality;  // 0-5
  // Max possible = 70; normalise to 0-100
  return Math.round((raw / 70) * 100);
}

export function classifyTradeType(signal: StrategySignal): TradeType {
  const entry = (signal.entryZone[0] + signal.entryZone[1]) / 2;
  const stopPct = Math.abs(entry - signal.stopLoss) / entry;
  if (stopPct < 0.003) return 'SCALP';
  if (stopPct < 0.015) return 'HYBRID';
  return 'SWING';
}

export function calculateRisk(signal: StrategySignal): RiskParameters {
  const entryPrice = (signal.entryZone[0] + signal.entryZone[1]) / 2;
  const stopDistance = Math.abs(entryPrice - signal.stopLoss);
  const stopDistancePct = entryPrice > 0 ? stopDistance / entryPrice : 0;

  const rewardDistance = Math.abs(signal.takeProfit - entryPrice);
  const rewardRiskRatio = stopDistance > 0 ? rewardDistance / stopDistance : 0;

  const tradeType = signal.tradeType ?? classifyTradeType(signal);
  const typeKey = tradeType === 'SCALP' ? 'scalp' : tradeType === 'HYBRID' ? 'hybrid' : 'swing';

  // Confidence-based risk %
  const rawRiskPct = RISK_PCT[typeKey][signal.tier] ?? 1.0;
  const regimeMultiplier = getRegimeMultiplier(signal.regime);
  const riskPct = rawRiskPct * regimeMultiplier;

  const assetCap = config.assetLeverageCap[signal.asset] ?? Infinity;
  const maxLev = leverageCap(signal.tier, tradeType);

  let suggestedLeverage: number;
  if (tradeType === 'SWING') {
    // Swing trades: use tier-based leverage directly (user target: 5–10x).
    // The risk-cap formula (riskPct/stopPct) yields 1–2x on wide structural stops
    // which is far too conservative for 1–5 day swing trading.
    suggestedLeverage = Math.max(1, Math.min(maxLev, assetCap));
  } else {
    // Scalp / Hybrid: derive leverage from desired risk % and stop distance
    const impliedLeverage = stopDistancePct > 0 ? riskPct / 100 / stopDistancePct : 1;
    suggestedLeverage = Math.max(1, Math.min(maxLev, assetCap, Math.ceil(impliedLeverage)));
  }

  const deploymentScore = calculateDeploymentScore(signal);

  return {
    entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    stopDistancePct,
    rewardRiskRatio,
    suggestedLeverage,
    riskPct,
    tradeType,
    deploymentScore,
  };
}

export function formatPrice(price: number, asset: string): string {
  let decimals: number;
  if (asset.startsWith('BTC') || asset === 'XAU/USD') {
    decimals = 0;  // BTC ~$80k, Gold ~$3000 — whole dollars are fine
  } else if (asset === 'XAG/USD') {
    decimals = 2;  // Silver ~$30
  } else if (price < 0.0001) {
    decimals = 8;  // micro-caps like PEPE (~0.000012)
  } else if (price < 1) {
    decimals = 5;  // sub-dollar assets
  } else if (price < 10) {
    decimals = 4;  // $1-$10 assets like XRP
  } else {
    decimals = 2;  // higher-priced assets (ETH, SOL, QQQ, SPY, etc.)
  }
  return `$${price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(2)}%`;
}
