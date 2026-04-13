import type { StrategySignal, MultiTimeframeData, Regime, ScoreComponents } from '../types';

export abstract class BaseStrategy {
  abstract readonly name: string;
  abstract readonly supportedRegimes: Regime[];

  /** Returns a signal if the strategy fires, or null if no setup found */
  abstract analyze(data: MultiTimeframeData, regime: Regime): StrategySignal | null;

  protected isRegimeSupported(regime: Regime): boolean {
    return this.supportedRegimes.includes(regime);
  }

  protected zeroComponents(): ScoreComponents {
    return {
      htfAlignment: 0,
      setupQuality: 0,
      momentum: 0,
      volatilityQuality: 0,
      regimeFit: 0,
      liquidity: 0,
      slippageRisk: 0,
      sessionQuality: 0,
      recentPerformance: 0,
    };
  }

  protected totalScore(c: ScoreComponents): number {
    return (
      c.htfAlignment +
      c.setupQuality +
      c.momentum +
      c.volatilityQuality +
      c.regimeFit +
      c.liquidity +
      c.slippageRisk +
      c.sessionQuality +
      c.recentPerformance
    );
  }
}
