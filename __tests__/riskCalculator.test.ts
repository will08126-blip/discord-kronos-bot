import { calculateRisk } from '../src/risk/riskCalculator';
import type { StrategySignal, Regime, TradeType, ScoreTier } from '../src/types';

// Mock config to avoid dependency on actual config file
jest.mock('../src/config', () => ({
  config: {
    trading: {
      maxLeverageScalp: 20,
      maxLeverageHybrid: 50,
      maxLeverageSwing: 10,
    },
    leverageTiers: {
      scalp: { ELITE: 20, STRONG: 15, MEDIUM: 10, NO_TRADE: 0 },
      hybrid: { ELITE: 50, STRONG: 35, MEDIUM: 15, NO_TRADE: 0 },
      swing: { ELITE: 10, STRONG: 8, MEDIUM: 5, NO_TRADE: 0 },
    },
    assetLeverageCap: {
      'BTC/USDT': 20,
      'ETH/USDT': 20,
      'XAU/USD': 10,
    },
  },
}));

describe('Risk Calculator', () => {
  const baseSignal: StrategySignal = {
    id: 'test',
    strategy: 'Test',
    asset: 'BTC/USDT',
    direction: 'LONG',
    tradeType: 'SCALP',
    entryZone: [100, 101] as [number, number],
    stopLoss: 99,
    takeProfit: 105,
    components: {
      htfAlignment: 20,
      setupQuality: 20,
      momentum: 15,
      volatilityQuality: 10,
      regimeFit: 10,
      liquidity: 10,
      slippageRisk: 5,
      sessionQuality: 5,
      recentPerformance: 5,
    },
    score: 80,
    tier: 'ELITE',
    regime: 'TREND_UP' as Regime,
    timestamp: Date.now(),
  };

  test('leverage cap for scalp ELITE should not exceed maxLeverageScalp', () => {
    const signal = { ...baseSignal, tradeType: 'SCALP' as TradeType, tier: 'ELITE' as ScoreTier, entryZone: [100, 101] as [number, number], stopLoss: 99.9 };
    const risk = calculateRisk(signal);
    expect(risk.suggestedLeverage).toBeLessThanOrEqual(20);
  });

  test('leverage cap for hybrid ELITE should not exceed maxLeverageHybrid', () => {
    const signal = { ...baseSignal, tradeType: 'HYBRID' as TradeType, tier: 'ELITE' as ScoreTier, entryZone: [100, 101] as [number, number], stopLoss: 98 };
    const risk = calculateRisk(signal);
    expect(risk.suggestedLeverage).toBeLessThanOrEqual(50);
  });

  test('leverage cap for swing ELITE should not exceed maxLeverageSwing', () => {
    const signal = { ...baseSignal, tradeType: 'SWING' as TradeType, tier: 'ELITE' as ScoreTier, entryZone: [100, 101] as [number, number], stopLoss: 95 };
    const risk = calculateRisk(signal);
    expect(risk.suggestedLeverage).toBeLessThanOrEqual(10);
  });

  test('asset leverage cap should be respected', () => {
    const signal = { ...baseSignal, asset: 'XAU/USD', tradeType: 'SCALP' as TradeType, tier: 'ELITE' as ScoreTier, entryZone: [100, 101] as [number, number], stopLoss: 99 };
    const risk = calculateRisk(signal);
    expect(risk.suggestedLeverage).toBeLessThanOrEqual(10);
  });

  test('regime multiplier reduces risk for VOL_EXPANSION', () => {
    const signal = { ...baseSignal, regime: 'VOL_EXPANSION' as Regime };
    const risk = calculateRisk(signal);
    // riskPct should be lower than base (5% * 0.7 = 3.5%)
    expect(risk.riskPct).toBeCloseTo(3.5, 1);
  });

  test('regime multiplier reduces risk for LOW_VOL_COMPRESSION', () => {
    const signal = { ...baseSignal, regime: 'LOW_VOL_COMPRESSION' as Regime };
    const risk = calculateRisk(signal);
    expect(risk.riskPct).toBeCloseTo(4.0, 1); // 5% * 0.8 = 4%
  });

  test('regime multiplier for TREND_UP remains 1.0', () => {
    const signal = { ...baseSignal, regime: 'TREND_UP' as Regime };
    const risk = calculateRisk(signal);
    expect(risk.riskPct).toBeCloseTo(5.0, 1);
  });

  test('stop distance zero should not cause infinite leverage', () => {
    const signal = { ...baseSignal, entryZone: [100, 100] as [number, number], stopLoss: 100 };
    const risk = calculateRisk(signal);
    expect(risk.suggestedLeverage).toBeGreaterThanOrEqual(1);
  });
});