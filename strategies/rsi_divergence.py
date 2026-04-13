"""
RSI Divergence Strategy
Detect bullish/bearish divergences for reversal signals
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Tuple
from . import TradingStrategy

class RSIDivergenceStrategy(TradingStrategy):
    """RSI divergence detection for reversal trades"""
    
    def __init__(self):
        super().__init__(name="RSIDivergence", weight=0.1)  # Lower weight - divergence can be early
        self.rsi_period = 14
        
    def analyze(self, data: pd.DataFrame, symbol: str, timeframe: str) -> Dict:
        """
        Detect RSI divergences
        
        Logic:
        1. Price makes new high/low but RSI doesn't (divergence)
        2. Wait for confirmation candle
        3. Enter reversal trade
        """
        if len(data) < 50:
            return {"direction": "NEUTRAL", "confidence": 0.3, "details": "Insufficient data"}
        
        # Calculate RSI
        rsi = self._calculate_rsi(data['close'], self.rsi_period)
        
        if rsi is None or len(rsi) < 20:
            return {"direction": "NEUTRAL", "confidence": 0.3, "details": "RSI calculation failed"}
        
        # Detect divergences
        bullish_div = self._detect_bullish_divergence(data, rsi)
        bearish_div = self._detect_bearish_divergence(data, rsi)
        
        current_price = data['close'].iloc[-1]
        current_rsi = rsi.iloc[-1]
        
        if bullish_div['detected']:
            # Bullish divergence (price lower low, RSI higher low)
            entry = current_price
            stop_loss = bullish_div['price_low'] * 0.97  # Below the low
            take_profit = entry * 1.08  # 8% target for reversals
            
            # Confidence based on RSI level and divergence strength
            confidence = 0.6
            if current_rsi < 30:  # Oversold
                confidence += 0.1
            if bullish_div['strength'] > 5:  # Strong divergence
                confidence += 0.1
            
            return {
                "direction": "LONG",
                "confidence": min(confidence, 0.85),
                "details": f"Bullish RSI divergence: {bullish_div['details']}",
                "entry": entry,
                "stop_loss": stop_loss,
                "take_profit": take_profit,
                "type": "BULLISH_DIVERGENCE"
            }
        
        elif bearish_div['detected']:
            # Bearish divergence (price higher high, RSI lower high)
            entry = current_price
            stop_loss = bearish_div['price_high'] * 1.03  # Above the high
            take_profit = entry * 0.92  # 8% target
            
            confidence = 0.55  # Slightly lower for bearish
            if current_rsi > 70:  # Overbought
                confidence += 0.1
            if bearish_div['strength'] > 5:
                confidence += 0.1
            
            return {
                "direction": "SHORT",
                "confidence": min(confidence, 0.8),
                "details": f"Bearish RSI divergence: {bearish_div['details']}",
                "entry": entry,
                "stop_loss": stop_loss,
                "take_profit": take_profit,
                "type": "BEARISH_DIVERGENCE"
            }
        
        # No divergence
        return {
            "direction": "NEUTRAL",
            "confidence": 0.3,
            "details": f"No RSI divergence (RSI: {current_rsi:.1f})",
            "type": "NO_DIVERGENCE"
        }
    
    def _calculate_rsi(self, prices: pd.Series, period: int = 14) -> pd.Series:
        """Calculate Relative Strength Index"""
        delta = prices.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        
        rs = gain / loss
        rsi = 100 - (100 / (1 + rs))
        return rsi
    
    def _detect_bullish_divergence(self, data: pd.DataFrame, rsi: pd.Series) -> Dict:
        """Detect bullish divergence (price lower low, RSI higher low)"""
        lookback = 30
        
        if len(data) < lookback or len(rsi) < lookback:
            return {"detected": False}
        
        # Find price lows and corresponding RSI values
        price_lows = []
        rsi_at_lows = []
        
        # Simple peak/trough detection
        for i in range(2, lookback - 2):
            idx = -i  # Negative index from end
            if (data['low'].iloc[idx] < data['low'].iloc[idx-1] and
                data['low'].iloc[idx] < data['low'].iloc[idx-2] and
                data['low'].iloc[idx] < data['low'].iloc[idx+1] and
                data['low'].iloc[idx] < data['low'].iloc[idx+2]):
                price_lows.append(data['low'].iloc[idx])
                rsi_at_lows.append(rsi.iloc[idx])
        
        if len(price_lows) < 2:
            return {"detected": False}
        
        # Check for divergence: price makes lower low, RSI makes higher low
        recent_low = price_lows[0]  # Most recent low
        recent_rsi = rsi_at_lows[0]
        prev_low = price_lows[1] if len(price_lows) > 1 else None
        prev_rsi = rsi_at_lows[1] if len(rsi_at_lows) > 1 else None
        
        if prev_low is not None and prev_rsi is not None:
            price_lower = recent_low < prev_low
            rsi_higher = recent_rsi > prev_rsi
            
            if price_lower and rsi_higher:
                strength = abs((recent_rsi - prev_rsi) / prev_rsi * 100)
                return {
                    "detected": True,
                    "price_low": recent_low,
                    "prev_price_low": prev_low,
                    "rsi_low": recent_rsi,
                    "prev_rsi_low": prev_rsi,
                    "strength": strength,
                    "details": f"Price lower low (${prev_low:.2f} → ${recent_low:.2f}), RSI higher low ({prev_rsi:.1f} → {recent_rsi:.1f})"
                }
        
        return {"detected": False}
    
    def _detect_bearish_divergence(self, data: pd.DataFrame, rsi: pd.Series) -> Dict:
        """Detect bearish divergence (price higher high, RSI lower high)"""
        lookback = 30
        
        if len(data) < lookback or len(rsi) < lookback:
            return {"detected": False}
        
        # Find price highs and corresponding RSI values
        price_highs = []
        rsi_at_highs = []
        
        for i in range(2, lookback - 2):
            idx = -i
            if (data['high'].iloc[idx] > data['high'].iloc[idx-1] and
                data['high'].iloc[idx] > data['high'].iloc[idx-2] and
                data['high'].iloc[idx] > data['high'].iloc[idx+1] and
                data['high'].iloc[idx] > data['high'].iloc[idx+2]):
                price_highs.append(data['high'].iloc[idx])
                rsi_at_highs.append(rsi.iloc[idx])
        
        if len(price_highs) < 2:
            return {"detected": False}
        
        # Check for divergence: price makes higher high, RSI makes lower high
        recent_high = price_highs[0]
        recent_rsi = rsi_at_highs[0]
        prev_high = price_highs[1] if len(price_highs) > 1 else None
        prev_rsi = rsi_at_highs[1] if len(rsi_at_highs) > 1 else None
        
        if prev_high is not None and prev_rsi is not None:
            price_higher = recent_high > prev_high
            rsi_lower = recent_rsi < prev_rsi
            
            if price_higher and rsi_lower:
                strength = abs((prev_rsi - recent_rsi) / prev_rsi * 100)
                return {
                    "detected": True,
                    "price_high": recent_high,
                    "prev_price_high": prev_high,
                    "rsi_high": recent_rsi,
                    "prev_rsi_high": prev_rsi,
                    "strength": strength,
                    "details": f"Price higher high (${prev_high:.2f} → ${recent_high:.2f}), RSI lower high ({prev_rsi:.1f} → {recent_rsi:.1f})"
                }
        
        return {"detected": False}