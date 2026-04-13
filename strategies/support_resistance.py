"""
Support and Resistance Bounce Strategy
Trade bounces off key price levels
"""

import pandas as pd
import numpy as np
from typing import Dict, List
from . import TradingStrategy

class SupportResistanceStrategy(TradingStrategy):
    """Trade bounces off support/resistance levels"""
    
    def __init__(self):
        super().__init__(name="SupportResistance", weight=0.9)
        self.levels_cache = {}  # Cache levels per symbol
        
    def analyze(self, data: pd.DataFrame, symbol: str, timeframe: str) -> Dict:
        """
        Detect support/resistance bounces
        
        Logic:
        1. Identify key support/resistance levels
        2. Wait for price to approach level
        3. Enter on bounce with confirmation
        """
        if len(data) < 100:
            return {"direction": "NEUTRAL", "confidence": 0.3, "details": "Insufficient data"}
        
        current_price = data['close'].iloc[-1]
        
        # Identify key levels
        support_levels, resistance_levels = self._identify_levels(data)
        
        # Check for bounces
        bounce_signal = self._detect_bounce(data, support_levels, resistance_levels, current_price)
        
        if bounce_signal['detected']:
            return {
                "direction": bounce_signal['direction'],
                "confidence": bounce_signal['confidence'],
                "details": bounce_signal['details'],
                "entry": bounce_signal['entry'],
                "stop_loss": bounce_signal['stop_loss'],
                "take_profit": bounce_signal['take_profit'],
                "type": bounce_signal['type']
            }
        
        # No bounce detected
        return {
            "direction": "NEUTRAL",
            "confidence": 0.3,
            "details": "No support/resistance bounce detected",
            "type": "NO_BOUNCE"
        }
    
    def _identify_levels(self, data: pd.DataFrame) -> tuple:
        """Identify support and resistance levels"""
        # Use pivot points and recent highs/lows
        lookback = 50
        highs = data['high'].iloc[-lookback:]
        lows = data['low'].iloc[-lookback:]
        
        # Find swing highs (resistance)
        resistance_levels = []
        for i in range(2, len(highs) - 2):
            if (highs.iloc[i] > highs.iloc[i-1] and 
                highs.iloc[i] > highs.iloc[i-2] and
                highs.iloc[i] > highs.iloc[i+1] and
                highs.iloc[i] > highs.iloc[i+2]):
                resistance_levels.append(highs.iloc[i])
        
        # Find swing lows (support)
        support_levels = []
        for i in range(2, len(lows) - 2):
            if (lows.iloc[i] < lows.iloc[i-1] and 
                lows.iloc[i] < lows.iloc[i-2] and
                lows.iloc[i] < lows.iloc[i+1] and
                lows.iloc[i] < lows.iloc[i+2]):
                support_levels.append(lows.iloc[i])
        
        # Filter to strongest levels (clusters)
        resistance_levels = self._cluster_levels(resistance_levels, threshold=0.01)  # 1%
        support_levels = self._cluster_levels(support_levels, threshold=0.01)
        
        return support_levels, resistance_levels
    
    def _cluster_levels(self, levels: List[float], threshold: float = 0.01) -> List[float]:
        """Group nearby levels into clusters"""
        if not levels:
            return []
        
        levels.sort()
        clusters = []
        current_cluster = [levels[0]]
        
        for level in levels[1:]:
            if abs(level - current_cluster[-1]) / current_cluster[-1] <= threshold:
                current_cluster.append(level)
            else:
                # Save cluster average
                clusters.append(sum(current_cluster) / len(current_cluster))
                current_cluster = [level]
        
        if current_cluster:
            clusters.append(sum(current_cluster) / len(current_cluster))
        
        return clusters
    
    def _detect_bounce(self, data: pd.DataFrame, support_levels: List[float], 
                      resistance_levels: List[float], current_price: float) -> Dict:
        """Detect bounce off support/resistance"""
        # Check support bounces (LONG)
        for support in support_levels:
            distance_pct = abs(current_price - support) / support * 100
            
            if distance_pct <= 1.0:  # Within 1% of support
                # Check for bounce confirmation (recent candle patterns)
                bounce_confirmed = self._confirm_bounce(data, 'support', support)
                
                if bounce_confirmed:
                    entry = current_price
                    stop_loss = support * 0.97  # 3% below support
                    take_profit = entry * 1.05  # 5% target
                    
                    return {
                        "detected": True,
                        "direction": "LONG",
                        "confidence": 0.7,
                        "details": f"Bounce off support at ${support:.2f}",
                        "entry": entry,
                        "stop_loss": stop_loss,
                        "take_profit": take_profit,
                        "type": "SUPPORT_BOUNCE"
                    }
        
        # Check resistance bounces (SHORT)
        for resistance in resistance_levels:
            distance_pct = abs(current_price - resistance) / resistance * 100
            
            if distance_pct <= 1.0:  # Within 1% of resistance
                # Check for bounce confirmation
                bounce_confirmed = self._confirm_bounce(data, 'resistance', resistance)
                
                if bounce_confirmed:
                    entry = current_price
                    stop_loss = resistance * 1.03  # 3% above resistance
                    take_profit = entry * 0.95  # 5% target
                    
                    return {
                        "detected": True,
                        "direction": "SHORT",
                        "confidence": 0.65,  # Slightly lower for shorts
                        "details": f"Bounce off resistance at ${resistance:.2f}",
                        "entry": entry,
                        "stop_loss": stop_loss,
                        "take_profit": take_profit,
                        "type": "RESISTANCE_BOUNCE"
                    }
        
        return {"detected": False}
    
    def _confirm_bounce(self, data: pd.DataFrame, level_type: str, level_price: float) -> bool:
        """Confirm bounce with candle patterns"""
        recent_candles = data.iloc[-5:]  # Last 5 candles
        
        if level_type == 'support':
            # Look for bullish reversal patterns near support
            # Simple: green candle after touching support
            touches = any(abs(candle['low'] - level_price) / level_price <= 0.005 
                         for _, candle in recent_candles.iterrows())
            
            if touches:
                # Check if last candle is bullish (close > open)
                last_candle = recent_candles.iloc[-1]
                is_bullish = last_candle['close'] > last_candle['open']
                return is_bullish
        
        elif level_type == 'resistance':
            # Look for bearish reversal patterns near resistance
            touches = any(abs(candle['high'] - level_price) / level_price <= 0.005 
                         for _, candle in recent_candles.iterrows())
            
            if touches:
                # Check if last candle is bearish (close < open)
                last_candle = recent_candles.iloc[-1]
                is_bearish = last_candle['close'] < last_candle['open']
                return is_bearish
        
        return False