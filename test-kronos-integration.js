/**
 * Quick test of Kronos integration
 * Run with: node test-kronos-integration.js
 */

// Simple test without TypeScript compilation
const { KronosValidator } = require('./dist/kronos/KronosValidator.js');

async function testKronosIntegration() {
  console.log('🧪 Testing Kronos Integration...\n');
  
  // Create Kronos validator
  const validator = new KronosValidator({
    enabled: true,
    weight: 0.3
  });
  
  // Initialize
  const initialized = await validator.initialize();
  console.log(`Kronos initialized: ${initialized ? '✅' : '❌'}`);
  
  if (!initialized) {
    console.log('Running in fallback mode...');
  }
  
  // Test signal
  const testSignal = {
    id: 'test-001',
    symbol: 'BTC/USDT',
    direction: 'LONG',
    entryPrice: 50000,
    stopLoss: 49000,
    takeProfit: 52000,
    timeframe: '15m',
    score: 75,
    tier: 'MEDIUM',
    notes: 'Test signal',
    timestamp: new Date()
  };
  
  console.log('\n📊 Test Signal:');
  console.log(`Symbol: ${testSignal.symbol}`);
  console.log(`Direction: ${testSignal.direction}`);
  console.log(`Price: $${testSignal.entryPrice}`);
  console.log(`Strategy Score: ${testSignal.score}/100`);
  
  // Validate with Kronos
  console.log('\n🔍 Validating with Kronos...');
  const validation = await validator.validateSignal(testSignal);
  
  console.log('\n📈 Kronos Validation Results:');
  console.log(`Alignment: ${validation.alignment}`);
  console.log(`Kronos Score: ${validation.kronosScore}/100`);
  console.log(`Confidence: ${(validation.confidence * 100).toFixed(1)}%`);
  console.log(`Recommended: ${validation.recommendedAction}`);
  
  // Calculate hybrid score
  const hybridScore = validator.calculateHybridScore(testSignal.score, validation.kronosScore);
  console.log(`\n🎯 Hybrid Score: ${Math.round(hybridScore)}/100`);
  
  // Decision
  console.log('\n🤔 Trading Decision:');
  if (validation.recommendedAction === 'REJECT') {
    console.log('❌ REJECT - Kronos strongly disagrees');
  } else if (hybridScore >= 70) {
    console.log('✅ CONFIRM - Strong hybrid signal');
  } else if (hybridScore >= 50) {
    console.log('⚠️  MODIFY - Consider adjusting position size');
  } else {
    console.log('⏸️  HOLD - Weak signal, wait for better opportunity');
  }
  
  // Test pure Kronos signal generation
  console.log('\n🤖 Testing pure Kronos signal generation...');
  const kronosSignal = await validator.generateKronosSignal('ETH/USDT', '1h');
  
  if (kronosSignal) {
    console.log(`\n📡 Kronos-only signal for ${kronosSignal.symbol}:`);
    console.log(`Direction: ${kronosSignal.direction}`);
    console.log(`Entry: $${kronosSignal.entryPrice.toFixed(2)}`);
    const changePct = ((kronosSignal.predictedExitPrice / kronosSignal.entryPrice - 1) * 100).toFixed(2);
    console.log(`Predicted: $${kronosSignal.predictedExitPrice.toFixed(2)} (${changePct}%)`);
    console.log(`Confidence: ${(kronosSignal.confidence * 100).toFixed(1)}%`);
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('✅ Kronos integration test complete!');
  console.log('\nNext:');
  console.log('1. Build TypeScript: npm run build');
  console.log('2. Integrate into your engine.ts');
  console.log('3. Start with 1 strategy + Kronos validation');
  console.log('4. Track performance improvement');
}

// Run test
testKronosIntegration().catch(console.error);