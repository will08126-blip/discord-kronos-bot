# `/mode` Command Guide

## Overview
The `/mode` command switches between different trading modes for the Kronos Discord bot. Each mode has different risk parameters and trading behavior.

## Available Modes

### 🛡️ Conservative Mode
- **Description**: Lower risk, more cautious trading
- **Confidence Threshold**: 75% (signals must be ≥75% confident)
- **Leverage Range**: 3x-10x
- **Stop Loss**: 2%
- **Take Profit**: 3%
- **Risk per Trade**: 2% of portfolio
- **Max Position**: 30% of portfolio
- **Best for**: New traders, risk-averse users, market uncertainty

### ⚡ Aggressive Mode
- **Description**: Higher risk, more aggressive trading
- **Confidence Threshold**: 65% (signals must be ≥65% confident)
- **Leverage Range**: 10x-25x
- **Stop Loss**: 1%
- **Take Profit**: 2%
- **Risk per Trade**: 4% of portfolio
- **Max Position**: 50% of portfolio
- **Best for**: Experienced traders, high-risk tolerance, trending markets

## Usage

### Basic Commands
```
/mode conservative    # Switch to conservative mode
/mode aggressive      # Switch to aggressive mode
```

### Checking Current Mode
```
/status              # Shows current trading mode
```

### Getting Help
```
/help                # Shows all commands including /mode
```

## What Changes with Mode

### 1. Signal Filtering
- **Conservative**: Only trades with ≥75% confidence
- **Aggressive**: Trades with ≥65% confidence

### 2. Paper Trading
- Auto-tracking respects mode confidence thresholds
- Each paper trade records which mode created it
- Position sizing uses mode-specific parameters

### 3. Risk Management
- Different leverage limits per mode
- Different stop loss/take profit levels
- Different position size limits

## Examples

### Switching to Conservative Mode
```
User: /mode conservative
Bot: ✅ Trading mode switched to **conservative**
     Confidence threshold: 75%
     Leverage: 3x-10x
     Stop loss: 2%, Take profit: 3%
     Paper trades will require ≥75% confidence
```

### Switching to Aggressive Mode
```
User: /mode aggressive
Bot: ⚡ Trading mode switched to **aggressive**
     Confidence threshold: 65%
     Leverage: 10x-25x
     Stop loss: 1%, Take profit: 2%
     Paper trades will require ≥65% confidence
```

## Tips

1. **Start Conservative**: If you're new to the bot, start with conservative mode
2. **Monitor Performance**: Use `/paper-stats` to track performance in each mode
3. **Switch Based on Market**: Use conservative mode in volatile markets, aggressive in trending markets
4. **Check Status**: Use `/status` to confirm your current mode
5. **Paper Test First**: Test both modes in paper trading before using real funds

## Technical Details

- **Configuration**: Stored in `mode_config.json`
- **Manager**: `mode_manager.py` handles mode switching
- **Integration**: `paper_commands.py` and `paper_tracker_updated.py` use mode settings
- **Persistence**: Mode persists across bot restarts

## Troubleshooting

**Issue**: Mode doesn't change
**Solution**: Check bot logs for errors, ensure `mode_config.json` is writable

**Issue**: Paper trades not respecting mode
**Solution**: Ensure you're using the updated paper tracker (`paper_tracker_updated.py`)

**Issue**: Can't see mode in status
**Solution**: The status command shows "Kronos Mode" (real/mock), not trading mode. Trading mode is shown when you switch modes.

## See Also
- `/paper-start` - Start paper trading
- `/paper-stats` - View paper trading statistics
- `/predict` - Get a prediction (respects mode confidence)
- `/scan` - Start scanning for signals