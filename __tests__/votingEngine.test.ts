import { applyAdaptationWeight, scoreTier, filterAndRankSignals, deduplicateSignals } from '../src/scoring/votingEngine';
import type { StrategySignal, ScoreComponents, ScoreTier } from '../src/types';

describe('Voting Engine', () => {
  const baseComponents: ScoreComponents = {
    htfAlignment: 15,
    setupQuality: 15,
    momentum: 10,
    volatilityQuality: 8,
    regimeFit: 8,
    liquidity: 8,
    slippageRisk: 5,
    sessionQuality: 5,
    recentPerformance: 6,
  };

  const baseSignal: StrategySignal = {
    id: 'test',
    strategy: 'Test',
    asset: 'BTC/USDT',
    direction: 'LONG',
    tradeType: 'SCALP',
    entryZone: [100, 101],
    stopLoss: 99,
    takeProfit: 105,
    components: baseComponents,
    score: 80,
    tier: 'ELITE',
    regime: 'TREND_UP',
    timestamp: Date.now(),
  };

  describe('applyAdaptationWeight', () => {
    test('weight 1.0 should not change score', () => {
      const signal = { ...baseSignal };
      const weighted = applyAdaptationWeight(signal, 1.0);
      expect(weighted.score).toBe(signal.score);
      expect(weighted.components.recentPerformance).toBe(signal.components.recentPerformance);
    });

    test('weight 0.5 reduces recentPerformance and setupQuality', () => {
      const signal = { ...baseSignal };
      const weighted = applyAdaptationWeight(signal, 0.5);
      expect(weighted.components.recentPerformance).toBeLessThan(signal.components.recentPerformance);
      expect(weighted.components.setupQuality).toBeLessThan(signal.components.setupQuality);
      expect(weighted.score).toBeLessThan(signal.score);
    });

    test('weight below 0.5 is clamped to 0.5', () => {
      const signal = { ...baseSignal };
      const weighted = applyAdaptationWeight(signal, 0.3);
      expect(weighted.score).toBeGreaterThan(0);
    });
  });

  describe('scoreTier', () => {
    test('score >= 80 returns ELITE', () => {
      expect(scoreTier(80)).toBe('ELITE');
      expect(scoreTier(85)).toBe('ELITE');
    });
    test('score >= 60 returns STRONG', () => {
      expect(scoreTier(60)).toBe('STRONG');
      expect(scoreTier(79)).toBe('STRONG');
    });
    test('score >= 40 returns MEDIUM', () => {
      expect(scoreTier(40)).toBe('MEDIUM');
      expect(scoreTier(59)).toBe('MEDIUM');
    });
    test('score < 40 returns NO_TRADE', () => {
      expect(scoreTier(39)).toBe('NO_TRADE');
      expect(scoreTier(0)).toBe('NO_TRADE');
    });
  });

  describe('filterAndRankSignals', () => {
    const signals: StrategySignal[] = [
      { ...baseSignal, id: '1', score: 70, tier: 'STRONG' },
      { ...baseSignal, id: '2', score: 85, tier: 'ELITE' },
      { ...baseSignal, id: '3', score: 50, tier: 'MEDIUM' },
      { ...baseSignal, id: '4', score: 30, tier: 'NO_TRADE' },
    ];
    test('filters out scores below threshold and NO_TRADE tier', () => {
      const filtered = filterAndRankSignals(signals, 60);
      expect(filtered.length).toBe(2); // only 70 and 85
      filtered.forEach(s => expect(s.score).toBeGreaterThanOrEqual(60));
    });
    test('returns sorted by score descending', () => {
      const filtered = filterAndRankSignals(signals, 40);
      expect(filtered[0].score).toBe(85);
      expect(filtered[1].score).toBe(70);
      expect(filtered[2].score).toBe(50);
    });
  });

  describe('deduplicateSignals', () => {
    const signals: StrategySignal[] = [
      { ...baseSignal, id: '1', asset: 'BTC/USDT', direction: 'LONG', strategy: 'Test', score: 70 },
      { ...baseSignal, id: '2', asset: 'BTC/USDT', direction: 'LONG', strategy: 'Test', score: 80 },
      { ...baseSignal, id: '3', asset: 'BTC/USDT', direction: 'SHORT', strategy: 'Test', score: 75 },
      { ...baseSignal, id: '4', asset: 'ETH/USDT', direction: 'LONG', strategy: 'Test', score: 65 },
    ];
    test('keeps highest score per asset/direction/strategy combo', () => {
      const deduped = deduplicateSignals(signals);
      expect(deduped.length).toBe(3); // BTC/LONG (score 80), BTC/SHORT, ETH/LONG
      const btcLong = deduped.find(s => s.asset === 'BTC/USDT' && s.direction === 'LONG');
      expect(btcLong?.score).toBe(80);
    });
  });
});