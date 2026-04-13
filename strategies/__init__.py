"""
Trading Strategies for Kronos Bot
Multi-strategy ensemble system
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Tuple, Optional
import pandas as pd
import numpy as np
from datetime import datetime

class TradingStrategy(ABC):
    """Base class for all trading strategies"""
    
    def __init__(self, name: str, weight: float = 1.0):
        self.name = name
        self.weight = weight
        self.history = []  # Track past predictions
        self.win_rate = 0.5  # Initial assumption
        self.total_predictions = 0
        self.correct_predictions = 0
        
    @abstractmethod
    def analyze(self, data: pd.DataFrame, symbol: str, timeframe: str) -> Dict:
        """
        Analyze market data and return signal
        
        Returns:
            Dict with keys: direction (LONG/SHORT/NEUTRAL), confidence (0-1), details
        """
        pass
    
    def update_history(self, prediction: str, actual: str):
        """Update strategy performance history"""
        self.total_predictions += 1
        if prediction == actual:
            self.correct_predictions += 1
        self.win_rate = self.correct_predictions / self.total_predictions if self.total_predictions > 0 else 0.5
        
    def get_weighted_vote(self) -> float:
        """Get strategy weight adjusted by recent performance"""
        return self.weight * self.win_rate