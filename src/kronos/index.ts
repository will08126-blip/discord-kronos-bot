/**
 * Kronos AI Integration Module
 * 
 * This module integrates Kronos AI predictions with the existing Discord Trading Bot.
 * It provides:
 * 1. Kronos validation of existing strategy signals
 * 2. Hybrid scoring (Technical + AI)
 * 3. Pure Kronos signal generation
 * 4. Performance tracking
 */

import { KronosValidator } from './KronosValidator';
import type {
  KronosPrediction,
  KronosValidationResult,
  KronosConfig,
  KronosSignal
} from './types';

export { KronosValidator };
export type {
  KronosPrediction,
  KronosValidationResult,
  KronosConfig,
  KronosSignal
};

/**
 * Main Kronos integration function
 * Call this to initialize Kronos integration
 */
export async function initializeKronosIntegration(config?: Partial<KronosConfig>) {
  const validator = new KronosValidator(config);
  const initialized = await validator.initialize();
  
  if (!initialized) {
    console.warn('Kronos integration failed to initialize. Running in fallback mode.');
  }
  
  return validator;
}

/**
 * Utility function to add Kronos validation to existing signals
 */
export async function validateSignalWithKronos(
  signal: StrategySignal,
  validator: KronosValidator
): Promise<StrategySignal & { kronosValidation?: KronosValidationResult }> {
  const validation = await validator.validateSignal(signal);
  
  // Calculate hybrid score
  const hybridScore = validator.calculateHybridScore(signal.score, validation.kronosScore);
  
  // Create enhanced signal with Kronos validation
  const enhancedSignal = {
    ...signal,
    score: Math.round(hybridScore),
    notes: signal.notes 
      ? `${signal.notes} | Kronos: ${validation.alignment} (${validation.kronosScore}/100)`
      : `Kronos: ${validation.alignment} (${validation.kronosScore}/100)`,
    kronosValidation: validation
  };
  
  // Adjust tier based on Kronos validation
  if (validation.recommendedAction === 'REJECT' && enhancedSignal.tier !== 'NO_TRADE') {
    enhancedSignal.tier = 'NO_TRADE';
    enhancedSignal.notes += ' | Kronos rejected';
  } else if (validation.alignment === 'STRONG_AGREE' && enhancedSignal.tier === 'MEDIUM') {
    enhancedSignal.tier = 'STRONG';
  }
  
  return enhancedSignal;
}

/**
 * Generate pure Kronos signals (alternative to strategy-based signals)
 */
export async function generateKronosSignals(
  assets: Asset[],
  timeframe: Timeframe,
  validator: KronosValidator
): Promise<KronosSignal[]> {
  const signals: KronosSignal[] = [];
  
  for (const asset of assets) {
    try {
      const signal = await validator.generateKronosSignal(asset, timeframe);
      if (signal && signal.confidence >= validator['config'].minConfidence) {
        signals.push(signal);
      }
    } catch (error) {
      console.error(`Failed to generate Kronos signal for ${asset}:`, error);
    }
  }
  
  return signals;
}

// Re-export types from main types file for convenience
import type { StrategySignal, Asset, Timeframe } from '../types';
export type { StrategySignal, Asset, Timeframe };