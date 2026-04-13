# Setup Guide — Discord Trading Bot

This guide walks you through every step needed to get the bot running.
Estimated time: 30–45 minutes.

---

## Part 1: Create a Discord Bot

### 1.1 — Create a Discord Application

1. Go to https://discord.com/developers/applications
2. Click **"New Application"** (top right)
3. Name it something like `Trading Signal Bot`, then click **Create**
4. You'll land on the application settings page

### 1.2 — Create the Bot

1. In the left sidebar, click **"Bot"**
2. Click **"Add Bot"** → **"Yes, do it!"**
3. Under the bot's username, click **"Reset Token"** → copy and save this — this is your `DISCORD_TOKEN`
   > ⚠️ Keep this token private. Anyone with it can control your bot.
4. Scroll down to **Privileged Gateway Intents** and enable:
   - **Message Content Intent** ✅
   - **Server Members Intent** ✅ (optional but doesn't hurt)
5. Click **Save Changes**

### 1.3 — Get your Client ID

1. In the left sidebar, click **"OAuth2"** → **"General"**
2. Copy the **"Client ID"** — this is your `DISCORD_CLIENT_ID`

### 1.4 — Invite the Bot to your Server

1. In the left sidebar, click **"OAuth2"** → **"URL Generator"**
2. Under **Scopes**, check: `bot` and `applications.commands`
3. Under **Bot Permissions**, check:
   - Read Messages/View Channels
   - Send Messages
   - Embed Links
   - Add Reactions
   - Use Slash Commands
4. Copy the generated URL at the bottom and open it in your browser
5. Select your Discord server and click **Authorize**

---

## Part 2: Set Up Your Discord Server

### 2.1 — Create Channels

In your Discord server, create two channels:

1. `#trading-signals` — where the bot posts buy/sell signals
2. `#trading-summary` — where the bot posts daily/weekly AI summaries

### 2.2 — Get Channel IDs

You need to enable Developer Mode in Discord:
1. Open Discord → User Settings (gear icon) → App Settings → Advanced
2. Toggle on **Developer Mode**

Now get the channel IDs:
1. Right-click on `#trading-signals` → **Copy Channel ID** — this is `SIGNAL_CHANNEL_ID`
2. Right-click on `#trading-summary` → **Copy Channel ID** — this is `SUMMARY_CHANNEL_ID`

---

## Part 3: Binance API (Market Data Only)

The bot only reads market data from Binance — it does NOT place orders.
You need a read-only API key so the bot can fetch price charts.

1. Log in to Binance → hover over your avatar (top right) → **API Management**
2. Click **Create API** → choose **System Generated**
3. Name it `TradingBotReadOnly`
4. **IMPORTANT**: Under permissions, ONLY check **"Enable Reading"** — do NOT enable trading
5. Copy the **API Key** (this is `BINANCE_API_KEY`) and **Secret Key** (`BINANCE_SECRET`)
   > ⚠️ The secret is only shown once — save it immediately

---

## Part 4: Anthropic API (Optional — for AI Summaries)

The bot uses Claude to generate daily/weekly performance summaries.
This is optional — the bot works without it (summaries will be text-only).

1. Go to https://console.anthropic.com
2. Click **API Keys** → **Create Key**
3. Name it `TradingBot` and copy the key — this is `ANTHROPIC_API_KEY`

---

## Part 5: Deploy on Render

You already have a $7/month Render account. Here's how to deploy:

### 5.1 — Push Code to GitHub

If you haven't already:
1. Create a GitHub account at https://github.com if needed
2. Create a new repository (private is fine)
3. Push this code:
   ```
   git remote add github https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push github main
   ```

### 5.2 — Create Render Service

1. Go to https://dashboard.render.com
2. Click **"New +"** → **"Background Worker"**
3. Connect your GitHub account and select your repository
4. Render will detect the `render.yaml` automatically

**Manual settings if not auto-detected:**
- **Runtime:** Node
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Plan:** Starter ($7/month)

### 5.3 — Add Environment Variables

In your Render service → **Environment** tab, add:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | your bot token from Part 1.2 |
| `DISCORD_CLIENT_ID` | your client ID from Part 1.3 |
| `SIGNAL_CHANNEL_ID` | channel ID from Part 2.2 |
| `SUMMARY_CHANNEL_ID` | channel ID from Part 2.2 |
| `BINANCE_API_KEY` | from Part 3 |
| `BINANCE_SECRET` | from Part 3 |
| `ANTHROPIC_API_KEY` | from Part 4 (optional) |
| `EXCHANGE_ID` | exchange for market data (default `binance` for Binance Futures) |
| `ACCOUNT_CAPITAL` | your account size in USD (e.g. `10000`) |
| `RISK_PER_TRADE` | dollar risk per trade (e.g. `50`) |
| `MAX_DAILY_LOSS` | stop scanning if daily loss exceeds this (e.g. `150`) |
| `MIN_SCORE_THRESHOLD` | minimum score to post signal (default `60`) |
| `MAX_LEVERAGE_SCALP` | hard cap for scalp trades (default `20`) |
| `MAX_LEVERAGE_HYBRID` | hard cap for hybrid trades (default `50`) |
| `MAX_LEVERAGE_SWING` | hard cap for swing trades (default `10`) |
| `SCAN_INTERVAL_MINUTES` | how often to scan for setups (default `5`) |

**Futures Configuration:** The bot uses Binance Futures endpoints by default (exchange ID `binance`). Leverage caps have been reduced for safety: scalp trades max 20x, swing trades max 10x. Adjust `MAX_LEVERAGE_SCALP` and `MAX_LEVERAGE_SWING` accordingly.

### 5.4 — Add Persistent Disk

The bot saves trade history and settings to `data/trades.json`.
Without a persistent disk, this resets every deploy.

1. In your Render service → **Disks** tab
2. Click **Add Disk**
3. Name: `bot-data`
4. Mount Path: `/opt/render/project/src/data`
5. Size: 1 GB (costs ~$0.25/month)
6. Click **Save**

### 5.5 — Deploy

Click **"Deploy"** — Render will build and start the bot.
Check the **Logs** tab — you should see:
```
[INFO] Discord bot ready — logged in as Trading Signal Bot#XXXX
[INFO] Deployed 6 global commands
[INFO] Starting scan scheduler: every 5 min
[INFO] Running initial scan...
```

> ⚠️ Global slash commands can take up to 1 hour to appear in Discord.
> For instant testing, pass your Guild ID to `deployCommands()` in `src/bot/events/ready.ts`

---

## Part 6: Using the Bot

### Receiving Signals

The bot scans every 5 minutes. When it finds a qualifying setup:

1. A **signal embed** appears in `#trading-signals` with:
   - Direction (LONG/SHORT), score, strategy name
   - Entry zone, stop loss, take profit
   - Suggested leverage and position size
   - Score breakdown

2. If you like the trade, **execute it manually on Binance Futures**

3. Click the **"Entered LONG/SHORT"** button in the Discord message

4. The bot starts tracking the position and will:
   - Update the trailing stop as price moves
   - Alert you when price approaches SL or TP
   - Extend the TP automatically if momentum continues

### Closing a Trade

When you close a trade on Binance, tell the bot using:
```
/close <position-id> <exit-price>
```

Example:
```
/close abc12345 68420
```

The bot will log the trade result, calculate P&L, and update your statistics.

### Available Commands

| Command | Description |
|---|---|
| `/status` | Bot status, pending signals, daily P&L |
| `/positions` | All open (confirmed) positions |
| `/close <id> <price>` | Record that you closed a trade |
| `/performance` | Win rate, profit factor, stats |
| `/performance today` | Today's stats only |
| `/performance week` | Last 7 days |
| `/toggle on/off` | Enable or disable signal scanning |
| `/report daily` | AI-generated daily summary |
| `/report weekly` | AI-generated weekly report |

---

## Part 7: Understanding Signals

### Score Tiers

| Score | Tier | Meaning |
|---|---|---|
| 80–100 | 🏆 ELITE | Highest-quality setup — all factors aligned |
| 60–79 | 💪 STRONG | Clean setup — most factors support the trade |
| 40–59 | ⚡ MEDIUM | Decent setup — some factors missing |
| 0–39 | ❌ NO TRADE | Suppressed — bot doesn't post these |

### Trade Types

- **⚡ Scalp** — 5m/1m timeframe, tight stop, higher leverage (up to 50x). Short holds.
- **🌊 Swing** — 15m/4h timeframe, wider stop, moderate leverage (up to 20x). Longer holds.

### Strategies

| Strategy | Regime | How it works |
|---|---|---|
| Trend Pullback | Trend Up/Down | Waits for RSI pullback to EMA20, enters on 5m confirmation candle |
| Breakout Retest | Trend, Vol Expansion | Finds broken key levels, enters on first retest with volume |
| Liquidity Sweep | Range | Detects false breakouts beyond swing highs/lows, enters reversal |
| Volatility Expansion | Low-Vol Compression | Enters when Bollinger squeeze breaks out with ATR expansion |

---

## Troubleshooting

**Bot doesn't appear in Discord / slash commands missing:**
- Global commands take up to 1 hour. Check Render logs for "Deployed X commands".
- Make sure the bot has the right permissions in your server.

**"Missing required environment variable" error:**
- Check Render environment variables — all required ones must be set.

**No signals posting:**
- Use `/status` to check if bot is enabled.
- Lower `MIN_SCORE_THRESHOLD` to 40 temporarily to see if any signals qualify.
- Markets during weekends or low-volatility periods produce fewer signals.

**Trades data lost after redeploy:**
- Make sure the Render persistent disk is attached (Part 5.4).

**"Daily loss limit hit" message:**
- Use `/toggle on` to manually re-enable (this also resets the daily loss gate).
