"""
Integration between Ensemble Strategy and Discord Bot
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import json
import pandas as pd
import numpy as np
from datetime import datetime
from strategies.ensemble import EnsembleStrategy

# Global ensemble instance
ensemble = None

def get_ensemble():
    """Get or create ensemble instance"""
    global ensemble
    if ensemble is None:
        ensemble = EnsembleStrategy(kronos_weight=1.5)
    return ensemble

def analyze_with_ensemble(symbol: str, timeframe: str, kronos_signal: dict = None) -> dict:
    """
    Analyze market with ensemble system
    
    Args:
        symbol: Trading symbol
        timeframe: Timeframe
        kronos_signal: Kronos AI signal (optional)
        
    Returns:
        Ensemble analysis result
    """
    try:
        # Generate mock data for testing (in production, fetch real data)
        data = generate_mock_data(symbol)
        
        # Get ensemble analysis
        ensemble_system = get_ensemble()
        result = ensemble_system.analyze(data, symbol, timeframe, kronos_signal)
        
        # Add metadata
        result['timestamp'] = datetime.now().isoformat()
        result['symbol'] = symbol
        result['timeframe'] = timeframe
        result['source'] = 'ENSEMBLE'
        
        return result
        
    except Exception as e:
        print(f"Ensemble analysis error: {e}")
        return {
            "direction": "NEUTRAL",
            "confidence": 0.3,
            "details": f"Ensemble error: {str(e)[:100]}",
            "type": "ERROR",
            "timestamp": datetime.now().isoformat(),
            "symbol": symbol,
            "timeframe": timeframe,
            "source": "ENSEMBLE_ERROR"
        }

def generate_mock_data(symbol: str, periods: int = 100) -> pd.DataFrame:
    """Generate mock OHLCV data for testing"""
    np.random.seed(42)
    
    base_prices = {
        'BTC/USDT': 50000,
        'ETH/USDT': 3000,
        'SOL/USDT': 150
    }
    
    base_price = base_prices.get(symbol, 100)
    
    # Generate random walk
    prices = []
    current = base_price
    
    for _ in range(periods):
        change = np.random.normal(0, 0.01)  # 1% daily volatility
        current *= (1 + change)
        prices.append(current)
    
    # Create OHLCV data
    data = {
        'open': [],
        'high': [],
        'low': [],
        'close': [],
        'volume': []
    }
    
    for price in prices:
        # Generate OHLC from base price with some randomness
        open_price = price
        high_price = price * (1 + abs(np.random.normal(0, 0.005)))
        low_price = price * (1 - abs(np.random.normal(0, 0.005)))
        close_price = price * (1 + np.random.normal(0, 0.002))
        volume = np.random.uniform(1000, 5000)
        
        data['open'].append(open_price)
        data['high'].append(high_price)
        data['low'].append(low_price)
        data['close'].append(close_price)
        data['volume'].append(volume)
    
    return pd.DataFrame(data)

def format_ensemble_signal_for_discord(signal: dict) -> dict:
    """Format ensemble signal for Discord embed"""
    direction = signal.get('direction', 'NEUTRAL')
    confidence = signal.get('confidence', 0.5) * 100
    details = signal.get('details', '')
    vote_details = signal.get('vote_details', [])
    market_regime = signal.get('market_regime', 'NEUTRAL')
    
    # Color based on direction
    if direction == 'LONG':
        color = 0x00FF00  # Green
        emoji = '📈'
    elif direction == 'SHORT':
        color = 0xFF0000  # Red
        emoji = '📉'
    else:
        color = 0x666666  # Gray
        emoji = '⚖️'
    
    # Create embed
    embed = {
        "title": f"{emoji} ENSEMBLE SIGNAL: {signal.get('symbol', 'N/A')}",
        "color": color,
        "description": f"**{direction}** with {confidence:.1f}% confidence\n{details}",
        "fields": [],
        "timestamp": signal.get('timestamp', datetime.now().isoformat()),
        "footer": {"text": "Multi-Strategy Ensemble • Use /paper-stats to track"}
    }
    
    # Add entry/exit levels if available
    entry = signal.get('entry')
    stop_loss = signal.get('stop_loss')
    take_profit = signal.get('take_profit')
    
    if entry and stop_loss and take_profit:
        embed["fields"].append({
            "name": "Entry",
            "value": f"${entry:,.2f}",
            "inline": True
        })
        embed["fields"].append({
            "name": "Stop Loss",
            "value": f"${stop_loss:,.2f}",
            "inline": True
        })
        embed["fields"].append({
            "name": "Take Profit",
            "value": f"${take_profit:,.2f}",
            "inline": True
        })
    
    # Add strategy votes summary
    if vote_details:
        long_strats = [v for v in vote_details if v['direction'] == 'LONG']
        short_strats = [v for v in vote_details if v['direction'] == 'SHORT']
        neutral_strats = [v for v in vote_details if v['direction'] == 'NEUTRAL']
        
        embed["fields"].append({
            "name": "Strategy Votes",
            "value": f"LONG: {len(long_strats)}, SHORT: {len(short_strats)}, NEUTRAL: {len(neutral_strats)}",
            "inline": False
        })
    
    # Add market regime
    regime_emoji = {
        "TRENDING_UP": "🚀",
        "TRENDING_DOWN": "📉",
        "RANGING": "↔️",
        "NEUTRAL": "⚖️"
    }.get(market_regime, "❓")
    
    embed["fields"].append({
        "name": "Market Regime",
        "value": f"{regime_emoji} {market_regime}",
        "inline": True
    })
    
    return embed

# Test function
if __name__ == "__main__":
    print("Testing ensemble integration...")
    
    # Test with Kronos signal
    kronos_signal = {
        "direction": "LONG",
        "confidence": 0.8,
        "source": "KRONOS_AI"
    }
    
    result = analyze_with_ensemble("BTC/USDT", "15m", kronos_signal)
    print(f"Ensemble result: {result['direction']} with {result['confidence']*100:.1f}% confidence")
    print(f"Details: {result['details'][:100]}...")
    
    # Format for Discord
    discord_embed = format_ensemble_signal_for_discord(result)
    print(f"\nDiscord embed keys: {list(discord_embed.keys())}")