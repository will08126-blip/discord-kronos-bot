/**
 * Kronos Integration Example
 * 
 * This shows how to integrate Kronos AI with the existing Discord Trading Bot.
 * Two approaches:
 * 1. Kronos as signal validator (enhances existing strategies)
 * 2. Kronos as standalone signal generator
 */

import { initializeKronosIntegration, validateSignalWithKronos, generateKronosSignals } from '../src/kronos';
import type { StrategySignal } from '../src/types';

/**
 * Example 1: Kronos as Signal Validator
 * 
 * This approach takes existing strategy signals and validates them with Kronos.
 * Best for: Enhancing your current working strategies with AI validation.
 */
async function exampleKronosValidator() {
  console.log('=== Example 1: Kronos as Signal Validator ===');
  
  // Initialize Kronos
  const kronos = await initializeKronosIntegration({
    enabled: true,
    weight: 0.3, // Kronos gets 30% weight in final score
    minConfidence: 0.6
  });
  
  // Simulate a signal from your existing strategy (e.g., BreakoutRetest)
  const strategySignal: StrategySignal = {
    id: 'signal-001',
    symbol: 'BTC/USDT',
    direction: 'LONG',
    entryPrice: 50000,
    stopLoss: 49000,
    takeProfit: 52000,
    timeframe: '15m',
    score: 75, // Strategy's own score (0-100)
    tier: 'MEDIUM',
    notes: 'Breakout retest confirmed',
    timestamp: new Date()
  };
  
  console.log(`Original signal: ${strategySignal.direction} ${strategySignal.symbol} @ $${strategySignal.entryPrice}`);
  console.log(`Strategy score: ${strategySignal.score}/100`);
  
  // Validate with Kronos
  const enhancedSignal = await validateSignalWithKronos(strategySignal, kronos);
  
  console.log(`\nAfter Kronos validation:`);
  console.log(`Hybrid score: ${enhancedSignal.score}/100`);
  console.log(`Kronos alignment: ${enhancedSignal.kronosValidation?.alignment}`);
  console.log(`Kronos score: ${enhancedSignal.kronosValidation?.kronosScore}/100`);
  console.log(`Recommended: ${enhancedSignal.kronosValidation?.recommendedAction}`);
  console.log(`Notes: ${enhancedSignal.notes}`);
  
  // Decision logic
  if (enhancedSignal.kronosValidation?.recommendedAction === 'REJECT') {
    console.log('\n🚫 Kronos recommends REJECTING this trade');
  } else if (enhancedSignal.score >= 70) {
    console.log('\n✅ Strong signal - Consider trading');
  } else {
    console.log('\n⚠️  Weak signal - Wait for better opportunity');
  }
}

/**
 * Example 2: Kronos as Standalone Signal Generator
 * 
 * This approach uses Kronos to generate its own signals.
 * Best for: Testing pure AI predictions vs your existing strategies.
 */
async function exampleKronosGenerator() {
  console.log('\n\n=== Example 2: Kronos as Standalone Signal Generator ===');
  
  const kronos = await initializeKronosIntegration({
    enabled: true,
    minConfidence: 0.7 // Higher threshold for standalone signals
  });
  
  // Generate Kronos signals for multiple assets
  const assets: Asset[] = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const timeframe: Timeframe = '1h';
  
  console.log(`Generating Kronos signals for: ${assets.join(', ')} (${timeframe})`);
  
  const signals = await generateKronosSignals(assets, timeframe, kronos);
  
  console.log(`\nGenerated ${signals.length} signals:`);
  
  signals.forEach((signal, index) => {
    console.log(`\n${index + 1}. ${signal.symbol}`);
    console.log(`   Direction: ${signal.direction}`);
    console.log(`   Entry: $${signal.entryPrice.toFixed(2)}`);
    console.log(`   Predicted: $${signal.predictedExitPrice.toFixed(2)} (${((signal.predictedExitPrice / signal.entryPrice - 1) * 100).toFixed(2)}%)`);
    console.log(`   Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
    console.log(`   Timeframe: ${signal.timeframe}`);
  });
  
  // Filter for high-confidence signals
  const highConfidenceSignals = signals.filter(s => s.confidence >= 0.8);
  console.log(`\n📊 High-confidence signals (≥80%): ${highConfidenceSignals.length}`);
}

/**
 * Example 3: Integration with Existing Bot Engine
 * 
 * This shows how to integrate Kronos into the main scanning cycle.
 */
async function exampleEngineIntegration() {
  console.log('\n\n=== Example 3: Engine Integration ===');
  
  // This would be integrated into your existing runScanCycle() function
  console.log('In your engine.ts, modify runScanCycle():');
  console.log(`
  // Before Kronos:
  async function runScanCycle() {
    const signals = await scanStrategies();
    await processSignals(signals);
  }
  
  // After Kronos integration:
  async function runScanCycleWithKronos() {
    // 1. Get signals from existing strategies
    const strategySignals = await scanStrategies();
    
    // 2. Initialize Kronos (once, cache it)
    const kronos = await getKronosValidator();
    
    // 3. Validate each signal with Kronos
    const enhancedSignals = await Promise.all(
      strategySignals.map(signal => validateSignalWithKronos(signal, kronos))
    );
    
    // 4. Filter based on Kronos validation
    const filteredSignals = enhancedSignals.filter(signal => {
      // Only trade if Kronos doesn't reject and score is good
      return signal.kronosValidation?.recommendedAction !== 'REJECT' && signal.score >= 60;
    });
    
    // 5. Process filtered signals
    await processSignals(filteredSignals);
    
    // 6. (Optional) Also generate pure Kronos signals
    const kronosSignals = await generateKronosSignals(['BTC/USDT'], '15m', kronos);
    const highConfidenceKronos = kronosSignals.filter(s => s.confidence >= 0.8);
    
    if (highConfidenceKronos.length > 0) {
      console.log('Also found pure Kronos signals:', highConfidenceKronos.length);
      // You could process these too, or just log them
    }
  }
  `);
}

/**
 * Example 4: Performance Comparison
 * 
 * Track how Kronos validation affects win rate.
 */
async function examplePerformanceTracking() {
  console.log('\n\n=== Example 4: Performance Tracking ===');
  
  console.log('To track Kronos performance, add to your performance/tracker.ts:');
  console.log(`
  interface TradeWithKronos {
    originalSignal: StrategySignal;
    kronosValidation: KronosValidationResult;
    tradeResult: 'WIN' | 'LOSS' | 'BREAKEVEN';
    pnl: number;
  }
  
  // Track metrics:
  // 1. Win rate with Kronos validation vs without
  // 2. Average P&L improvement
  // 3. Which alignment levels perform best
  // 4. Optimal Kronos weight (0.3? 0.5? 0.7?)
  
  // Example metrics to track:
  const metrics = {
    totalTrades: 0,
    tradesWithKronosAgree: 0,
    tradesWithKronosDisagree: 0,
    winRateWithAgreement: 0,
    winRateWithDisagreement: 0,
    avgPnlImprovement: 0
  };
  `);
}

// Run all examples
async function runAllExamples() {
  console.log('🚀 Kronos AI Integration Examples');
  console.log('=' .repeat(50));
  
  try {
    await exampleKronosValidator();
    await exampleKronosGenerator();
    await exampleEngineIntegration();
    await examplePerformanceTracking();
    
    console.log('\n' + '=' .repeat(50));
    console.log('✅ All examples completed');
    console.log('\nNext steps:');
    console.log('1. Test Kronos integration with 1 strategy first');
    console.log('2. Run backtest comparing with/without Kronos');
    console.log('3. Adjust Kronos weight based on results');
    console.log('4. Deploy to your Discord bot');
    
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Types needed for the examples
type Asset = string;
type Timeframe = '1w' | '1d' | '4h' | '15m' | '5m' | '1m';

// Uncomment to run
// runAllExamples().catch(console.error);

export { runAllExamples };