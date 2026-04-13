"""
Trend Pullback Strategy
Buy pullbacks in uptrends, sell rallies in downtrends
"""

import pandas as pd
import numpy as np
from typing import Dict
from . import TradingStrategy

class TrendPullbackStrategy(TradingStrategy):
    """Trend following with pullback entries"""
    
    def __init__(self):
        super().__init__(name="TrendPullback", weight=1.0)
        
    def analyze(self, data: pd.DataFrame, symbol: str, timeframe: str) -> Dict:
        """
        Detect trend and pullback opportunities
        
        Logic:
        1. Determine trend direction (EMA slope)
        2. Wait for pullback to dynamic support/resistance
        3. Enter in trend direction
        """
        if len(data) < 100:
            return {"direction": "NEUTRAL", "confidence": 0.3, "details": "Insufficient data"}
        
        # Calculate indicators
        ema_fast = self._calculate_ema(data['close'], 20)
        ema_slow = self._calculate_ema(data['close'], 50)
        current_price = data['close'].iloc[-1]
        
        # Determine trend
        trend, trend_strength = self._determine_trend(ema_fast, ema_slow)
        
        if trend == "UPTREND":
            # Look for pullback to buy
            pullback_signal = self._detect_uptrend_pullback(data, ema_fast, ema_slow, current_price)
            
            if pullback_signal['detected']:
                confidence = 0.6 + (trend_strength * 0.2)  # 0.6-0.8 based on trend strength
                return {
                    "direction": "LONG",
                    "confidence": min(confidence, 0.85),
                    "details": f"Uptrend pullback: {pullback_signal['details']}",
                    "entry": pullback_signal['entry'],
                    "stop_loss": pullback_signal['stop_loss'],
                    "take_profit": pullback_signal['take_profit'],
                    "type": "UPTREND_PULLBACK"
                }
                
        elif trend == "DOWNTREND":
            # Look for rally to sell (short)
            rally_signal = self._detect_downtrend_rally(data, ema_fast, ema_slow, current_price)
            
            if rally_signal['detected']:
                confidence = 0.55 + (trend_strength * 0.2)  # 0.55-0.75 (shorts typically lower confidence)
                return {
                    "direction": "SHORT",
                    "confidence": min(confidence, 0.8),
                    "details": f"Downtrend rally: {rally_signal['details']}",
                    "entry": rally_signal['entry'],
                    "stop_loss": rally_signal['stop_loss'],
                    "take_profit": rally_signal['take_profit'],
                    "type": "DOWNTREND_RALLY"
                }
        
        # No clear pullback/rally
        return {
            "direction": "NEUTRAL",
            "confidence": 0.3,
            "details": f"{trend} detected but no clear pullback/rally",
            "type": "TREND_NO_ENTRY"
        }
    
    def _calculate_ema(self, prices: pd.Series, period: int) -> pd.Series:
        """Calculate Exponential Moving Average"""
        return prices.ewm(span=period, adjust=False).mean()
    
    def _determine_trend(self, ema_fast: pd.Series, ema_slow: pd.Series) -> tuple:
        """Determine trend direction and strength"""
        if len(ema_fast) < 2 or len(ema_slow) < 2:
            return "NEUTRAL", 0.0
        
        # Fast EMA above Slow EMA = Uptrend
        fast_current = ema_fast.iloc[-1]
        fast_prev = ema_fast.iloc[-2]
        slow_current = ema_slow.iloc[-1]
        slow_prev = ema_slow.iloc[-2]
        
        # Check alignment and slope
        fast_above_slow = fast_current > slow_current
        fast_slope = (fast_current - fast_prev) / fast_prev
        slow_slope = (slow_current - slow_prev) / slow_prev
        
        if fast_above_slow and fast_slope > 0 and slow_slope > 0:
            # Strong uptrend
            strength = min(abs(fast_slope) * 100, 1.0)  # Convert to 0-1 scale
            return "UPTREND", strength
            
        elif not fast_above_slow and fast_slope < 0 and slow_slope < 0:
            # Strong downtrend
            strength = min(abs(fast_slope) * 100, 1.0)
            return "DOWNTREND", strength
            
        else:
            # Neutral/consolidation
            return "NEUTRAL", 0.0
    
    def _detect_uptrend_pullback(self, data: pd.DataFrame, ema_fast: pd.Series, ema_slow: pd.Series, current_price: float) -> Dict:
        """Detect pullback in uptrend for long entry"""
        lookback = 10
        
        # Check if price pulled back to EMA
        fast_ema = ema_fast.iloc[-1]
        slow_ema = ema_slow.iloc[-1]
        
        # Price should be near or below fast EMA (pullback)
        price_to_fast_ratio = current_price / fast_ema
        
        if 0.98 <= price_to_fast_ratio <= 1.02:  # Within 2% of fast EMA
            # Check for recent high (to measure pullback depth)
            recent_high = data['high'].iloc[-lookback:].max()
            pullback_depth = (recent_high - current_price) / recent_high * 100
            
            if 2 <= pullback_depth <= 8:  # 2-8% pullback is ideal
                entry = current_price
                stop_loss = min(slow_ema, current_price * 0.97)  # Below slow EMA or 3%
                take_profit = entry * (1 + (pullback_depth / 100 * 1.5))  # 1.5x pullback depth
                
                return {
                    "detected": True,
                    "details": f"Pullback {pullback_depth:.1f}% to EMA",
                    "entry": entry,
                    "stop_loss": stop_loss,
                    "take_profit": take_profit
                }
        
        return {"detected": False, "details": "No pullback detected"}
    
    def _detect_downtrend_rally(self, data: pd.DataFrame, ema_fast: pd.Series, ema_slow: pd.Series, current_price: float) -> Dict:
        """Detect rally in downtrend for short entry"""
        lookback = 10
        
        # Check if price rallied to EMA
        fast_ema = ema_fast.iloc[-1]
        slow_ema = ema_slow.iloc[-1]
        
        # Price should be near or above fast EMA (rally)
        price_to_fast_ratio = current_price / fast_ema
        
        if 0.98 <= price_to_fast_ratio <= 1.02:  # Within 2% of fast EMA
            # Check for recent low (to measure rally height)
            recent_low = data['low'].iloc[-lookback:].min()
            rally_height = (current_price - recent_low) / recent_low * 100
            
            if 2 <= rally_height <= 8:  # 2-8% rally is ideal
                entry = current_price
                stop_loss = max(slow_ema, current_price * 1.03)  # Above slow EMA or 3%
                take_profit = entry * (1 - (rally_height / 100 * 1.5))  # 1.5x rally height
                
                return {
                    "detected": True,
                    "details": f"Rally {rally_height:.1f}% to EMA",
                    "entry": entry,
                    "stop_loss": stop_loss,
                    "take_profit": take_profit
                }
        
        return {"detected": False, "details": "No rally detected"}