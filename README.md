# 🤖 Discord Kronos Bot

AI-enhanced trading signals powered by Kronos foundation model.

## 🎯 What This Is

A **new Discord bot** dedicated to Kronos AI trading signals. **Separate from your existing working bot.** This is a testing/development environment for Kronos AI integration.

## ✨ Features

- **Kronos AI Validation:** AI-powered signal validation
- **Discord Integration:** Real-time signal notifications
- **Mock Mode:** Safe testing without real trading
- **Performance Tracking:** Compare vs original bot
- **Separate Environment:** Won't affect your working bot

## 🚀 Quick Start

### 1. Create Discord Bot
1. Go to https://discord.com/developers/applications
2. Create new application: `Kronos AI Bot`
3. Copy bot token
4. Invite bot to your server with permissions:
   - Send Messages
   - Embed Links
   - Read Message History

### 2. Setup Environment
```bash
# Clone/copy this repo
cd discord-kronos-bot

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your Discord token
nano .env
```

### 3. Run Bot
```bash
# Development mode
npm run dev

# Or build and run
npm run build
npm start
```

## 📋 Bot Commands

| Command | Description |
|---------|-------------|
| `!kronos start` | Start automatic scanning |
| `!kronos stop` | Stop scanning |
| `!kronos status` | Show bot status |
| `!kronos test` | Send test signal |
| `!kronos help` | Show help |

## 🔧 Configuration

### Discord Bot
- **Token:** From Discord Developer Portal
- **Channel:** Dedicated channel for signals

### Kronos AI
- **Weight:** 0.3 (30% influence on signals)
- **Min Confidence:** 70% (only high-confidence signals)
- **Mode:** Mock predictions (safe testing)

### Scanning
- **Assets:** BTC/USDT, ETH/USDT, SOL/USDT
- **Timeframe:** 15 minutes
- **Interval:** 5 minutes

## 🏗️ Architecture

```
discord-kronos-bot/
├── src/
│   ├── kronos/           # Kronos AI integration
│   │   ├── types.ts
│   │   ├── KronosValidator.ts
│   │   └── index.ts
│   ├── kronos-bot.ts     # Discord bot
│   └── types.ts          # Shared types
├── index.ts              # Main entry
├── package.json          # Dependencies
└── .env                  # Configuration
```

## 📊 How It Works

1. **Scan Cycle (every 5 minutes):**
   - Kronos analyzes BTC/ETH/SOL
   - Generates AI predictions
   - Filters for high confidence (≥70%)

2. **Signal Validation:**
   - Kronos validates price direction
   - Calculates confidence score
   - Creates Discord embed

3. **Discord Notification:**
   - Sends formatted signal to channel
   - Includes entry price, prediction, confidence
   - Color-coded (green=long, red=short)

## 🧪 Testing

### Mock Mode (Default)
- Safe testing without real Kronos models
- Simulated predictions
- No risk to your accounts

### Real Kronos Mode
```bash
# Download Kronos models (100MB)
python -c "
from huggingface_hub import snapshot_download
snapshot_download(repo_id='NeoQuasar/Kronos-Tokenizer-base', local_dir='models/tokenizer')
snapshot_download(repo_id='NeoQuasar/Kronos-small', local_dir='models/kronos-small')
"

# Update .env
KRONOS_ENABLED=true
```

## 🔄 Integration with Existing Bot

### Option A: Separate Bots (Recommended)
- **Original bot:** Continues working as is
- **Kronos bot:** New channel, new signals
- **Compare:** Side-by-side performance

### Option B: Signal Forwarding
Kronos bot → Original bot (future enhancement)

### Option C: Full Integration
Merge Kronos into original bot (after testing)

## 📈 Performance Tracking

Track in your Discord channel:
1. **Signal accuracy:** How often Kronos is right
2. **Win rate:** Compare vs original bot
3. **Confidence correlation:** Higher confidence = better accuracy?

## 🚨 Current Limitations

### Mock Mode
- Not real Kronos predictions
- Random signal generation
- For testing only

### Real Kronos
- Models are large (100MB)
- Prediction is slow
- Needs GPU for production

## 🎯 Roadmap

### Phase 1: Testing (Week 1)
- Mock predictions
- Discord integration
- Basic commands

### Phase 2: Real Kronos (Week 2)
- Download models
- Real predictions
- Performance comparison

### Phase 3: Optimization (Week 3)
- Parameter tuning
- Backtesting
- Integration options

### Phase 4: Production (Week 4+)
- Real-time signals
- Performance tracking
- Possible merge with original bot

## 🔗 Related Projects

- [Original Discord Bot](https://github.com/will08126-blip/Discord-Trading-Bot)
- [Kronos Trading Bot](https://github.com/will08126-blip/kronos-trading-bot)
- [Kronos AI](https://github.com/shiyu-coder/Kronos)

## 📝 License

MIT

## 👥 Maintainers

- **Will Contaxus** - Project owner
- **Claw** - AI assistant & integration developer

---

**Status:** 🟢 Ready for testing  
**Mode:** Mock predictions  
**Risk:** None (separate from working bot)