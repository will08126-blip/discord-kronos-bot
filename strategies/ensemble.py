"""
Ensemble Strategy System
Combines multiple strategies with weighted voting
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Tuple
from datetime import datetime
import json
import os

from .breakout_retest import BreakoutRetestStrategy
from .trend_pullback import TrendPullbackStrategy
from .support_resistance import SupportResistanceStrategy
from .rsi_divergence import RSIDivergenceStrategy

class EnsembleStrategy:
    """Combines multiple strategies with weighted voting"""
    
    def __init__(self, kronos_weight: float = 1.5):
        # Initialize all strategies
        self.strategies = {
            'breakout_retest': BreakoutRetestStrategy(),
            'trend_pullback': TrendPullbackStrategy(),
            'support_resistance': SupportResistanceStrategy(),
            'rsi_divergence': RSIDivergenceStrategy()
        }
        
        # Kronos gets special weight (AI bonus)
        self.kronos_weight = kronos_weight
        
        # Performance tracking
        self.performance_file = './paper_data/strategy_performance.json'
        self.load_performance()
        
        # Market regime detection
        self.current_regime = "NEUTRAL"  # TRENDING_UP, TRENDING_DOWN, RANGING, NEUTRAL
        
    def load_performance(self):
        """Load strategy performance from file"""
        if os.path.exists(self.performance_file):
            try:
                with open(self.performance_file, 'r') as f:
                    data = json.load(f)
                    for strat_name, perf in data.items():
                        if strat_name in self.strategies:
                            self.strategies[strat_name].win_rate = perf.get('win_rate', 0.5)
                            self.strategies[strat_name].total_predictions = perf.get('total_predictions', 0)
                            self.strategies[strat_name].correct_predictions = perf.get('correct_predictions', 0)
            except:
                pass  # Start fresh if file corrupted
    
    def save_performance(self):
        """Save strategy performance to file"""
        data = {}
        for name, strategy in self.strategies.items():
            data[name] = {
                'win_rate': strategy.win_rate,
                'total_predictions': strategy.total_predictions,
                'correct_predictions': strategy.correct_predictions,
                'weight': strategy.weight
            }
        
        os.makedirs(os.path.dirname(self.performance_file), exist_ok=True)
        with open(self.performance_file, 'w') as f:
            json.dump(data, f, indent=2)
    
    def analyze(self, data: pd.DataFrame, symbol: str, timeframe: str, 
                kronos_signal: Dict = None) -> Dict:
        """
        Run ensemble analysis with all strategies
        
        Args:
            data: OHLCV market data
            symbol: Trading symbol
            timeframe: Timeframe
            kronos_signal: Optional Kronos AI signal
            
        Returns:
            Combined signal with ensemble voting
        """
        # Detect market regime first
        self._detect_market_regime(data)
        
        # Run all strategies
        strategy_signals = {}
        for name, strategy in self.strategies.items():
            try:
                signal = strategy.analyze(data, symbol, timeframe)
                strategy_signals[name] = signal
            except Exception as e:
                print(f"Error in {name} strategy: {e}")
                strategy_signals[name] = {
                    "direction": "NEUTRAL",
                    "confidence": 0.3,
                    "details": f"Error: {str(e)[:50]}",
                    "type": "ERROR"
                }
        
        # Add Kronos signal if provided
        if kronos_signal:
            strategy_signals['kronos'] = {
                "direction": kronos_signal.get('direction', 'NEUTRAL'),
                "confidence": kronos_signal.get('confidence', 0.5),
                "details": kronos_signal.get('source', 'KRONOS_AI'),
                "type": "KRONOS_AI"
            }
        
        # Combine signals with weighted voting
        combined = self._combine_signals(strategy_signals, data, symbol)
        
        # Update performance tracking (in production, would update after trade result)
        # For now, just save current state
        self.save_performance()
        
        return combined
    
    def _detect_market_regime(self, data: pd.DataFrame):
        """Detect current market regime"""
        if len(data) < 50:
            self.current_regime = "NEUTRAL"
            return
        
        # Calculate trends
        prices = data['close']
        sma_20 = prices.rolling(20).mean()
        sma_50 = prices.rolling(50).mean()
        
        if len(sma_20) < 1 or len(sma_50) < 1:
            self.current_regime = "NEUTRAL"
            return
        
        # Check if trending
        current_sma_20 = sma_20.iloc[-1]
        current_sma_50 = sma_50.iloc[-1]
        
        # Price deviation from SMA
        current_price = prices.iloc[-1]
        deviation_20 = abs(current_price - current_sma_20) / current_sma_20
        deviation_50 = abs(current_price - current_sma_50) / current_sma_50
        
        # Volume trend
        volume = data['volume']
        volume_sma = volume.rolling(20).mean()
        volume_ratio = volume.iloc[-1] / volume_sma.iloc[-1] if volume_sma.iloc[-1] > 0 else 1
        
        # Determine regime
        if current_sma_20 > current_sma_50 and deviation_20 > 0.02 and volume_ratio > 1.2:
            self.current_regime = "TRENDING_UP"
        elif current_sma_20 < current_sma_50 and deviation_20 > 0.02 and volume_ratio > 1.2:
            self.current_regime = "TRENDING_DOWN"
        elif deviation_20 < 0.01 and deviation_50 < 0.015:
            self.current_regime = "RANGING"
        else:
            self.current_regime = "NEUTRAL"
    
    def _combine_signals(self, strategy_signals: Dict, data: pd.DataFrame, symbol: str) -> Dict:
        """Combine multiple strategy signals with weighted voting"""
        # Count votes
        long_votes = 0
        short_votes = 0
        neutral_votes = 0
        total_weight = 0
        
        vote_details = []
        
        for name, signal in strategy_signals.items():
            direction = signal.get('direction', 'NEUTRAL')
            confidence = signal.get('confidence', 0.5)
            
            # Get strategy weight
            if name == 'kronos':
                weight = self.kronos_weight
            elif name in self.strategies:
                strategy = self.strategies[name]
                weight = strategy.get_weighted_vote()
                
                # Adjust weight based on market regime
                weight = self._adjust_weight_for_regime(name, weight)
            else:
                weight = 1.0
            
            # Apply confidence to weight
            effective_weight = weight * confidence
            
            if direction == 'LONG':
                long_votes += effective_weight
            elif direction == 'SHORT':
                short_votes += effective_weight
            else:
                neutral_votes += effective_weight
            
            total_weight += effective_weight
            
            vote_details.append({
                'strategy': name,
                'direction': direction,
                'confidence': confidence,
                'weight': weight,
                'effective_weight': effective_weight,
                'details': signal.get('details', '')
            })
        
        if total_weight == 0:
            return {
                "direction": "NEUTRAL",
                "confidence": 0.3,
                "details": "No strategy votes",
                "type": "ENSEMBLE_NEUTRAL",
                "vote_details": vote_details
            }
        
        # Calculate percentages
        long_pct = long_votes / total_weight * 100
        short_pct = short_votes / total_weight * 100
        neutral_pct = neutral_votes / total_weight * 100
        
        # Determine final direction
        if long_pct >= 60:  # Strong long consensus
            final_direction = "LONG"
            final_confidence = min(0.3 + (long_pct - 60) / 40, 0.9)  # 60% → 0.3, 100% → 0.9
        elif short_pct >= 60:  # Strong short consensus
            final_direction = "SHORT"
            final_confidence = min(0.25 + (short_pct - 60) / 40, 0.85)  # Slightly lower for shorts
        else:
            final_direction = "NEUTRAL"
            final_confidence = max(long_pct, short_pct) / 100 * 0.5  # Scale to 0-0.5
        
        # Adjust confidence based on agreement level
        max_pct = max(long_pct, short_pct, neutral_pct)
        if max_pct >= 80:  # Very high agreement
            final_confidence = min(final_confidence * 1.2, 0.95)
        elif max_pct <= 40:  # Low agreement
            final_confidence = final_confidence * 0.7
        
        # Generate details
        details = f"Ensemble: {final_direction} ({final_confidence*100:.1f}% confidence)\n"
        details += f"Votes: LONG {long_pct:.1f}%, SHORT {short_pct:.1f}%, NEUTRAL {neutral_pct:.1f}%\n"
        details += f"Market: {self.current_regime}"
        
        # Calculate entry/exit levels (average of strategies that agree)
        entry, stop_loss, take_profit = self._calculate_levels(strategy_signals, final_direction, data)
        
        return {
            "direction": final_direction,
            "confidence": final_confidence,
            "details": details,
            "entry": entry,
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "type": "ENSEMBLE",
            "vote_details": vote_details,
            "market_regime": self.current_regime,
            "vote_percentages": {
                "long": long_pct,
                "short": short_pct,
                "neutral": neutral_pct
            }
        }
    
    def _adjust_weight_for_regime(self, strategy_name: str, weight: float) -> float:
        """Adjust strategy weight based on market regime"""
        regime_weights = {
            "TRENDING_UP": {
                "trend_pullback": 1.3,  # Excels in trends
                "breakout_retest": 1.2,
                "support_resistance": 0.8,  # Less effective in strong trends
                "rsi_divergence": 0.7  # Early in trends
            },
            "TRENDING_DOWN": {
                "trend_pullback": 1.2,
                "breakout_retest": 1.1,
                "support_resistance": 0.9,
                "rsi_divergence": 0.8
            },
            "RANGING": {
                "trend_pullback": 0.7,  # Poor in ranges
                "breakout_retest": 1.3,  # Excels in ranges
                "support_resistance": 1.4,  # Best in ranges
                "rsi_divergence": 1.1  # Good for range extremes
            },
            "NEUTRAL": {
                # Default weights
            }
        }
        
        if self.current_regime in regime_weights:
            regime_multiplier = regime_weights[self.current_regime].get(strategy_name, 1.0)
            return weight * regime_multiplier
        
        return weight
    
    def _calculate_levels(self, strategy_signals: Dict, final_direction: str, data: pd.DataFrame) -> Tuple:
        """Calculate average entry/stop/take from agreeing strategies"""
        current_price = data['close'].iloc[-1]
        
        entries = []
        stops = []
        takes = []
        
        for name, signal in strategy_signals.items():
            if signal.get('direction') == final_direction:
                entry = signal.get('entry')
                stop = signal.get('stop_loss')
                take = signal.get('take_profit')
                
                if entry is not None:
                    entries.append(entry)
                if stop is not None:
                    stops.append(stop)
                if take is not None:
                    takes.append(take)
        
        # Calculate averages or use defaults
        if entries:
            avg_entry = sum(entries) / len(entries)
        else:
            avg_entry = current_price
        
        if stops:
            avg_stop = sum(stops) / len(stops)
        else:
            # Default stop: 3% for LONG, 3% for SHORT
            if final_direction == "LONG":
                avg_stop = avg_entry * 0.97
            else:
                avg_stop = avg_entry * 1.03
        
        if takes:
            avg_take = sum(takes) / len(takes)
        else:
            # Default take: 5% for LONG, 5% for SHORT
            if final_direction == "LONG":
                avg_take = avg_entry * 1.05
            else:
                avg_take = avg_entry * 0.95
        
        return avg_entry, avg_stop, avg_take
    
    def update_strategy_performance(self, strategy_name: str, predicted: str, actual: str):
        """Update strategy performance after trade result"""
        if strategy_name in self.strategies:
            self.strategies[strategy_name].update_history(predicted, actual)
        self.save_performance()