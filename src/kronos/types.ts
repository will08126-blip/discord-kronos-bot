/**
 * Kronos AI Integration Types
 */

export interface KronosPrediction {
  symbol: string;
  timestamp: Date;
  predictedPrices: {
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
  };
  predictedChangePct: number;
  confidence: number; // 0-1
  timeHorizon: number; // hours
}

export interface KronosValidationResult {
  originalSignalId: string;
  kronosScore: number; // 0-100
  alignment: 'STRONG_AGREE' | 'AGREE' | 'NEUTRAL' | 'DISAGREE' | 'STRONG_DISAGREE';
  kronosPrediction?: KronosPrediction;
  recommendedAction: 'CONFIRM' | 'MODIFY' | 'REJECT';
  confidence: number;
}

export interface KronosConfig {
  enabled: boolean;
  modelPath: string;
  lookbackCandles: number;
  predictionHorizon: number;
  minConfidence: number;
  weight: number; // 0-1 weight in hybrid scoring
}

export interface KronosSignal {
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  entryPrice: number;
  predictedExitPrice: number;
  confidence: number;
  timeframe: string;
  timestamp: Date;
  source: 'KRONOS_ONLY' | 'HYBRID';
}