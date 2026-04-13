"""
Breakout Retest Strategy
Based on your Discord bot's proven logic
"""

import pandas as pd
import numpy as np
from typing import Dict
from . import TradingStrategy

class BreakoutRetestStrategy(TradingStrategy):
    """Breakout and retest strategy for crypto"""
    
    def __init__(self):
        super().__init__(name="BreakoutRetest", weight=0.3)  # Reduced: Kronos is CEO
        self.resistance_levels = {}
        self.support_levels = {}
        
    def analyze(self, data: pd.DataFrame, symbol: str, timeframe: str) -> Dict:
        """
        Detect breakout retest patterns
        
        Logic:
        1. Identify recent resistance break
        2. Wait for pullback (retest)
        3. Enter long on successful retest
        """
        if len(data) < 100:
            return {"direction": "NEUTRAL", "confidence": 0.3, "details": "Insufficient data"}
        
        # Calculate key levels
        recent_high = data['high'].iloc[-50:].max()
        recent_low = data['low'].iloc[-50:].min()
        current_price = data['close'].iloc[-1]
        
        # Identify if we're near a breakout level
        resistance_break = self._detect_resistance_break(data, recent_high)
        support_break = self._detect_support_break(data, recent_low)
        
        # Breakout Retest Logic
        if resistance_break['broken'] and not resistance_break['retested']:
            # Price broke resistance, waiting for retest
            return {
                "direction": "NEUTRAL",
                "confidence": 0.4,
                "details": f"Resistance broken at ${resistance_break['level']:.2f}, waiting for retest",
                "level": resistance_break['level'],
                "type": "BREAKOUT_WAITING"
            }
        
        elif resistance_break['broken'] and resistance_break['retested']:
            # Successful retest - BUY signal
            retest_depth = (resistance_break['level'] - resistance_break['retest_low']) / resistance_break['level'] * 100
            
            if retest_depth < 3:  # Shallow retest (strong)
                confidence = 0.8
            elif retest_depth < 5:  # Moderate retest
                confidence = 0.7
            else:  # Deep retest (weaker)
                confidence = 0.6
                
            return {
                "direction": "LONG",
                "confidence": confidence,
                "details": f"Breakout retest confirmed at ${resistance_break['level']:.2f} (retest: {retest_depth:.1f}%)",
                "entry": resistance_break['retest_low'],
                "stop_loss": resistance_break['retest_low'] * 0.97,
                "take_profit": resistance_break['level'] * 1.05,
                "type": "BREAKOUT_RETEST_LONG"
            }
        
        # Support Break (Short logic - inverse of above)
        elif support_break['broken'] and support_break['retested']:
            retest_depth = (support_break['retest_high'] - support_break['level']) / support_break['level'] * 100
            
            if retest_depth < 3:
                confidence = 0.75
            elif retest_depth < 5:
                confidence = 0.65
            else:
                confidence = 0.55
                
            return {
                "direction": "SHORT",
                "confidence": confidence,
                "details": f"Support break retest at ${support_break['level']:.2f} (retest: {retest_depth:.1f}%)",
                "entry": support_break['retest_high'],
                "stop_loss": support_break['retest_high'] * 1.03,
                "take_profit": support_break['level'] * 0.95,
                "type": "SUPPORT_BREAK_SHORT"
            }
        
        # No clear pattern
        return {
            "direction": "NEUTRAL",
            "confidence": 0.3,
            "details": "No breakout retest pattern detected",
            "type": "NO_PATTERN"
        }
    
    def _detect_resistance_break(self, data: pd.DataFrame, recent_high: float) -> Dict:
        """Detect resistance break and retest"""
        # Simplified logic - in production, use proper swing high detection
        lookback = 20
        prices = data['high'].iloc[-lookback*2:-lookback]
        resistance = prices.max() if len(prices) > 0 else 0
        
        if resistance == 0:
            return {"broken": False, "retested": False, "level": 0}
        
        # Check if broken recently
        recent_prices = data['high'].iloc[-lookback:]
        broken = any(price > resistance * 1.005 for price in recent_prices)  # 0.5% break
        
        if not broken:
            return {"broken": False, "retested": False, "level": resistance}
        
        # Check for retest (price comes back near resistance)
        recent_lows = data['low'].iloc[-lookback:]
        retest_low = None
        for i in range(len(recent_prices)):
            if recent_prices.iloc[i] > resistance * 1.005:  # After break
                # Look for subsequent low near resistance
                subsequent_lows = recent_lows.iloc[i:]
                if len(subsequent_lows) > 0:
                    min_low = subsequent_lows.min()
                    if abs(min_low - resistance) / resistance < 0.02:  # Within 2%
                        retest_low = min_low
                        break
        
        return {
            "broken": True,
            "retested": retest_low is not None,
            "level": resistance,
            "retest_low": retest_low
        }
    
    def _detect_support_break(self, data: pd.DataFrame, recent_low: float) -> Dict:
        """Detect support break and retest (inverse of resistance)"""
        lookback = 20
        prices = data['low'].iloc[-lookback*2:-lookback]
        support = prices.min() if len(prices) > 0 else 0
        
        if support == 0:
            return {"broken": False, "retested": False, "level": 0}
        
        # Check if broken recently
        recent_prices = data['low'].iloc[-lookback:]
        broken = any(price < support * 0.995 for price in recent_prices)  # 0.5% break
        
        if not broken:
            return {"broken": False, "retested": False, "level": support}
        
        # Check for retest (price comes back near support)
        recent_highs = data['high'].iloc[-lookback:]
        retest_high = None
        for i in range(len(recent_prices)):
            if recent_prices.iloc[i] < support * 0.995:  # After break
                # Look for subsequent high near support
                subsequent_highs = recent_highs.iloc[i:]
                if len(subsequent_highs) > 0:
                    max_high = subsequent_highs.max()
                    if abs(max_high - support) / support < 0.02:  # Within 2%
                        retest_high = max_high
                        break
        
        return {
            "broken": True,
            "retested": retest_high is not None,
            "level": support,
            "retest_high": retest_high
        }