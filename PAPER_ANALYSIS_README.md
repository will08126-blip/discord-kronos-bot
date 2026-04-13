# Paper Trading Analysis Script

This script fetches paper‑trading messages from your Discord channel and generates a performance report.

## Prerequisites

- Node.js 20+
- Discord bot token with `Message Content` intent enabled
- Bot invited to the server with `View Channel` and `Read Message History` permissions

## Setup

1. **Copy the example config** (if not already present):
   ```bash
   cp paper_analysis_config.example.json paper_analysis_config.json
   ```

2. **Edit `paper_analysis_config.json`** with your credentials:
   ```json
   {
     "discord": {
       "token": "YOUR_BOT_TOKEN",
       "channelId": "YOUR_CHANNEL_ID",
       "guildId": null,
       "paperChannelName": "paper-trading"
     },
     "analysis": {
       "maxMessages": 1000,
       "timeRangeDays": 30,
       "outputFile": "paper_trading_analysis.md"
     }
   }
   ```
   - Either `channelId` **or** `guildId` + `paperChannelName` must be provided.
   - `timeRangeDays` is currently unused (future feature).

## Usage

Run the script from the `discord-trading-bot` directory:

```bash
node paper_analysis.js
```

Optional arguments:
- `--config path/to/config.json` – specify a custom config file
- `--output path/to/report.md` – override the output file

## Output

The script prints the analysis to the console and saves it to `paper_trading_analysis.md` (or the specified file). The report includes:

- Total trades, win rate, average R, total P&L
- Final equity and max drawdown
- Table of all trades with P&L
- Recommendations based on the metrics

## Integration with OpenClaw

You can call this script from any OpenClaw session by asking:

> "Run the paper trading analysis script"

I'll execute it and share the report.

## Security Notes

- Keep `paper_analysis_config.json` private (never commit to git).
- The script uses Discord.js and connects only to your specified channel.
- Token is used only for the duration of the script and not stored.