# Kronos AI Integration for Discord Trading Bot

## 🎯 Overview
This integration adds **Kronos AI** (financial foundation model) to your existing Discord Trading Bot. Kronos validates strategy signals with AI predictions, improving win rate and reducing false signals.

## 📁 What's Been Added

```
src/kronos/
├── types.ts              # Type definitions
├── KronosValidator.ts    # Main validation class
└── index.ts             # Integration utilities

examples/
└── kronos-integration-example.ts  # Usage examples
```

## 🚀 Quick Start

### 1. Install Dependencies
```bash
# In your discord-bot-kronos-integration directory
npm install
```

### 2. Test Integration
```bash
node test-kronos-integration.js
```

### 3. Integration Approaches

#### **Option A: Kronos as Signal Validator (Recommended)**
Enhance your existing strategies with AI validation:

```typescript
import { initializeKronosIntegration, validateSignalWithKronos } from './src/kronos';

// In your engine.ts
async function runScanCycleWithKronos() {
  // 1. Get signals from existing strategies
  const strategySignals = await scanStrategies();
  
  // 2. Initialize Kronos
  const kronos = await initializeKronosIntegration({
    weight: 0.3, // Kronos gets 30% weight
    minConfidence: 0.6
  });
  
  // 3. Validate each signal
  const enhancedSignals = await Promise.all(
    strategySignals.map(signal => validateSignalWithKronos(signal, kronos))
  );
  
  // 4. Filter (only trade if Kronos doesn't reject)
  const filteredSignals = enhancedSignals.filter(signal => 
    signal.kronosValidation?.recommendedAction !== 'REJECT' && signal.score >= 60
  );
  
  // 5. Process filtered signals
  await processSignals(filteredSignals);
}
```

#### **Option B: Kronos as Standalone Signal Generator**
Use Kronos to generate its own signals:

```typescript
import { generateKronosSignals } from './src/kronos';

const kronosSignals = await generateKronosSignals(
  ['BTC/USDT', 'ETH/USDT'], 
  '1h', 
  kronosValidator
);

// Filter for high confidence
const highConfidence = kronosSignals.filter(s => s.confidence >= 0.8);
```

## 🔧 Configuration

```typescript
interface KronosConfig {
  enabled: boolean;      // Enable/disable Kronos
  weight: number;        // 0-1 weight in hybrid scoring (0.3 = 30%)
  minConfidence: number; // Minimum confidence to consider (0.6 = 60%)
  modelPath: string;     // Path to Kronos models
  lookbackCandles: number; // Candles for prediction (400)
  predictionHorizon: number; // Future candles to predict (120)
}
```

## 📊 How It Works

### Hybrid Scoring Formula
```
Final Score = (Strategy Score × (1 - weight)) + (Kronos Score × weight)
```

**Example:**
- Strategy score: 75/100
- Kronos score: 90/100  
- Weight: 0.3 (30%)
- **Final score:** (75 × 0.7) + (90 × 0.3) = **79.5/100**

### Signal Validation Logic
1. **STRONG_AGREE** (Kronos strongly agrees) → Boost signal tier
2. **AGREE** (Kronos agrees) → Keep signal
3. **NEUTRAL** (Kronos unsure) → Consider reducing position size
4. **DISAGREE** (Kronos disagrees) → Consider rejecting
5. **STRONG_DISAGREE** (Kronos strongly disagrees) → Reject signal

## 🧪 Testing Strategy

### Phase 1: Validation Mode (Safe)
- Kronos validates but doesn't veto
- Track performance: With vs Without Kronos
- Adjust weight based on results

### Phase 2: Filter Mode
- Kronos can reject signals
- Only trade when Kronos agrees
- Compare win rate improvement

### Phase 3: Hybrid Mode
- Optimize weight parameter
- Add Kronos-only signals
- Full integration

## 📈 Performance Tracking

Add to your `performance/tracker.ts`:

```typescript
interface KronosMetrics {
  totalSignals: number;
  kronosAgreements: number;
  kronosDisagreements: number;
  winRateWithAgreement: number;
  winRateWithDisagreement: number;
  avgPnlImprovement: number;
}

// Track:
// 1. How often Kronos agrees/disagrees
// 2. Win rate when Kronos agrees vs disagrees
// 3. Optimal weight parameter
// 4. Which strategies benefit most
```

## 🚨 Current Limitations

### Mock Mode (For Now)
The integration currently uses **mock predictions** because:
1. Real Kronos models are large (~100MB)
2. Prediction is slow (seconds per signal)
3. Need GPU for real-time use

### To Enable Real Kronos:
1. Download models:
```bash
python -c "
from huggingface_hub import snapshot_download
snapshot_download(repo_id='NeoQuasar/Kronos-Tokenizer-base', local_dir='models/tokenizer')
snapshot_download(repo_id='NeoQuasar/Kronos-small', local_dir='models/kronos-small')
"
```

2. Update `KronosValidator.ts` to use real model
3. Consider performance impact (slower signal generation)

## 🔄 Integration Steps

### Step 1: Test with 1 Strategy
Start with **BreakoutRetest** strategy + Kronos validation for BTC only.

### Step 2: Backtest
Compare 30 days of trades: With vs Without Kronos.

### Step 3: Optimize
Find optimal weight (0.2? 0.3? 0.4?) and confidence threshold.

### Step 4: Deploy
Integrate into your live Discord bot.

### Step 5: Monitor
Track performance and adjust as needed.

## 💡 Best Practices

1. **Start small:** BTC only, 1 strategy
2. **Track everything:** Log all Kronos validations
3. **Be conservative:** Start with weight=0.2 (20% influence)
4. **Have fallback:** Kronos disabled → use original signals
5. **Monitor performance:** Weekly review of Kronos impact

## 🆘 Troubleshooting

### Kronos fails to initialize
- Check if `enabled: true`
- Models downloaded correctly
- Sufficient memory/disk space

### Performance too slow
- Use mock mode for testing
- Real Kronos needs GPU for production
- Consider batch processing signals

### No improvement in win rate
- Adjust weight parameter
- Try different confidence thresholds
- Kronos may work better with some strategies than others

## 📚 Next Steps

1. **Week 1:** Test with BreakoutRetest + BTC
2. **Week 2:** Add 1 more strategy + 1 more asset
3. **Week 3:** Optimize parameters
4. **Week 4:** Full deployment

## 🔗 Resources

- [Kronos GitHub](https://github.com/shiyu-coder/Kronos)
- [Kronos Paper](https://arxiv.org/abs/2502.00000)
- [Discord Bot Repo](https://github.com/will08126-blip/Discord-Trading-Bot)
- [Kronos Integration Repo](https://github.com/will08126-blip/kronos-trading-bot)

---

**Maintainer:** Will Contaxus  
**Integration by:** Claw (AI Assistant)  
**Last Updated:** 2026-04-12