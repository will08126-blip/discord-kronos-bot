#!/usr/bin/env python3
"""
Paper Trading Tracker for Kronos Discord Bot
Tracks virtual trades of Kronos signals automatically
"""

import json
import os
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
import random

class PaperTrade:
    """Represents a virtual paper trade"""
    
    def __init__(self, signal: Dict, entry_price: float, portfolio_capital: float = 2000):
        self.id = f"trade_{int(time.time())}_{random.randint(1000, 9999)}"
        self.signal_id = signal.get('id', 'unknown')
        self.symbol = signal.get('symbol', 'BTC/USDT')
        self.direction = signal.get('direction', 'LONG')  # LONG or SHORT
        self.entry_price = entry_price
        self.entry_time = datetime.now().isoformat()
        
        # SMART POSITION SIZING
        self.confidence = signal.get('confidence', 0.5)
        self.portfolio_capital = portfolio_capital
        
        # Calculate stop loss and take profit (1% SL, 2% TP) - Professional leverage trading
        if self.direction == 'LONG':
            self.stop_loss = entry_price * 0.99  # 1% stop loss
            self.take_profit = entry_price * 1.02  # 2% take profit
            self.stop_loss_percent = 0.01
        else:  # SHORT
            self.stop_loss = entry_price * 1.01  # 1% stop loss
            self.take_profit = entry_price * 0.98  # 2% take profit
            self.stop_loss_percent = 0.01
        
        # RISK: 4% of capital per trade
        risk_amount = portfolio_capital * 0.04  # $80 on $2000
        
        # Position size based on risk and stop-loss distance
        # Formula: position_size = risk_amount / (entry_price * stop_loss_percent)
        risk_per_share = entry_price * self.stop_loss_percent
        
        # Calculate maximum position we can take (50% of capital)
        max_position_by_capital = (portfolio_capital * 0.5) / entry_price
        
        # Calculate ideal position based on risk
        ideal_position_by_risk = risk_amount / risk_per_share
        
        # Use the SMALLER of the two (risk-based or capital-based)
        base_position_size = min(ideal_position_by_risk, max_position_by_capital)
        
        # SMART LEVERAGE: Calculate based on confidence
        # Start with confidence-based leverage (5x-25x)
        confidence_leverage = max(5, min(25, self.confidence * 30))
        
        # Calculate what leverage this position represents
        # leverage = position_size / base_position_without_leverage
        # But base_position_without_leverage would be risk_amount / risk_per_share
        # Actually, let's think differently...
        
        # If we're using less than ideal position (due to capital constraints),
        # we can use higher leverage to get closer to our risk target
        if base_position_size < ideal_position_by_risk:
            # We're capital-constrained, use higher leverage to increase risk
            # But cap at reasonable level
            needed_leverage = ideal_position_by_risk / base_position_size
            self.leverage = min(confidence_leverage, needed_leverage, 25)
        else:
            # We're using ideal position, use confidence-based leverage
            self.leverage = confidence_leverage
        
        # Final position size with leverage
        self.position_size = base_position_size * self.leverage
        
        # Convert to notional value (position value in USD)
        self.notional_value = self.position_size * entry_price
        
        # Final safety check: cap at 50% of portfolio
        max_position_value = portfolio_capital * 0.5
        if self.notional_value > max_position_value:
            # Scale down
            scale_factor = max_position_value / self.notional_value
            self.position_size *= scale_factor
            self.notional_value = self.position_size * entry_price
            self.leverage *= scale_factor
        
        self.status = 'OPEN'
        self.exit_price = None
        self.exit_time = None
        self.pnl = 0.0
        self.pnl_percent = 0.0
        self.source = signal.get('source', 'KRONOS')
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON storage"""
        return {
            'id': self.id,
            'signal_id': self.signal_id,
            'symbol': self.symbol,
            'direction': self.direction,
            'entry_price': self.entry_price,
            'entry_time': self.entry_time,
            'leverage': self.leverage,
            'position_size': self.position_size,
            'position_value': self.notional_value,
            'leverage': self.leverage,
            'risk_percent': 4.0,
            'stop_loss_percent': self.stop_loss_percent,
            'status': self.status,
            'exit_price': self.exit_price,
            'exit_time': self.exit_time,
            'pnl': self.pnl,
            'pnl_percent': self.pnl_percent,
            'stop_loss': self.stop_loss,
            'take_profit': self.take_profit,
            'source': self.source,
            'confidence': self.confidence
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'PaperTrade':
        """Create PaperTrade from dictionary"""
        trade = cls.__new__(cls)
        trade.id = data['id']
        trade.signal_id = data['signal_id']
        trade.symbol = data['symbol']
        trade.direction = data['direction']
        trade.entry_price = data['entry_price']
        trade.entry_time = data['entry_time']
        trade.leverage = data['leverage']
        trade.position_size = data['position_size']
        trade.status = data['status']
        trade.exit_price = data.get('exit_price')
        trade.exit_time = data.get('exit_time')
        trade.pnl = data['pnl']
        trade.pnl_percent = data['pnl_percent']
        trade.stop_loss = data['stop_loss']
        trade.take_profit = data['take_profit']
        trade.source = data['source']
        trade.confidence = data['confidence']
        return trade
    
    def update_pnl(self, current_price: float) -> Tuple[float, float]:
        """Update P&L based on current price"""
        if self.status != 'OPEN':
            return self.pnl, self.pnl_percent
        
        if self.direction == 'LONG':
            price_change = current_price - self.entry_price
        else:  # SHORT
            price_change = self.entry_price - current_price
        
        # Calculate P&L with leverage
        self.pnl = (price_change / self.entry_price) * self.position_size * self.leverage
        self.pnl_percent = (price_change / self.entry_price) * 100 * self.leverage
        
        # Check for stop loss / take profit
        if self.direction == 'LONG':
            if current_price <= self.stop_loss:
                self.close(current_price, 'STOP_LOSS')
            elif current_price >= self.take_profit:
                self.close(current_price, 'TAKE_PROFIT')
        else:  # SHORT
            if current_price >= self.stop_loss:
                self.close(current_price, 'STOP_LOSS')
            elif current_price <= self.take_profit:
                self.close(current_price, 'TAKE_PROFIT')
        
        return self.pnl, self.pnl_percent
    
    def close(self, exit_price: float, reason: str = 'MANUAL'):
        """Close the trade"""
        if self.status != 'OPEN':
            return
        
        self.exit_price = exit_price
        self.exit_time = datetime.now().isoformat()
        self.status = reason
        
        # Final P&L calculation
        if self.direction == 'LONG':
            price_change = exit_price - self.entry_price
        else:  # SHORT
            price_change = self.entry_price - exit_price
        
        self.pnl = (price_change / self.entry_price) * self.position_size * self.leverage
        self.pnl_percent = (price_change / self.entry_price) * 100 * self.leverage


class PaperTradingTracker:
    """Manages paper trading portfolio"""
    
    def __init__(self, data_dir: str = './paper_data'):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        
        self.trades_file = os.path.join(data_dir, 'trades.json')
        self.stats_file = os.path.join(data_dir, 'stats.json')
        self.portfolio_file = os.path.join(data_dir, 'portfolio.json')
        
        self.trades: List[PaperTrade] = []
        
        # Risk management settings
        self.risk_per_trade = 0.04  # 4% risk per trade
        self.max_concurrent_trades = 3
        self.max_position_size_percent = 0.5  # Max 50% of capital in one trade
        self.stats: Dict = {}
        self.portfolio: Dict = {
            'balance': 10000.0,  # Starting balance
            'initial_balance': 10000.0,
            'last_updated': datetime.now().isoformat(),
            'total_trades': 0,
            'open_trades': 0,
            'total_pnl': 0.0
        }
        
        self.load_data()
    
    def load_data(self):
        """Load trades and stats from files"""
        try:
            if os.path.exists(self.trades_file):
                with open(self.trades_file, 'r') as f:
                    trades_data = json.load(f)
                    self.trades = [PaperTrade.from_dict(t) for t in trades_data]
            
            if os.path.exists(self.stats_file):
                with open(self.stats_file, 'r') as f:
                    self.stats = json.load(f)
            
            if os.path.exists(self.portfolio_file):
                with open(self.portfolio_file, 'r') as f:
                    self.portfolio = json.load(f)
                    
        except Exception as e:
            print(f"Error loading data: {e}")
            # Start fresh
            self.trades = []
            self.stats = {}
            self.portfolio = {
                'balance': 10000.0,
                'initial_balance': 10000.0,
                'last_updated': datetime.now().isoformat(),
                'total_trades': 0,
                'open_trades': 0,
                'total_pnl': 0.0
            }
    
    def save_data(self):
        """Save trades and stats to files"""
        try:
            trades_data = [trade.to_dict() for trade in self.trades]
            with open(self.trades_file, 'w') as f:
                json.dump(trades_data, f, indent=2)
            
            with open(self.stats_file, 'w') as f:
                json.dump(self.stats, f, indent=2)
            
            with open(self.portfolio_file, 'w') as f:
                json.dump(self.portfolio, f, indent=2)
                
        except Exception as e:
            print(f"Error saving data: {e}")
    
    def create_trade(self, signal: Dict) -> Optional[PaperTrade]:
        """Create a new paper trade from Kronos signal"""
        try:
            # Get current price (mock for now - in production, fetch from API)
            current_price = self.get_current_price(signal['symbol'])
            
            # Determine leverage based on confidence
            confidence = signal.get('confidence', 0.5)
            if confidence >= 0.85:
                leverage = 25.0
            elif confidence >= 0.75:
                leverage = 15.0
            elif confidence >= 0.7:
                leverage = 5.0
            else:
                leverage = 1.0
            
            # Create trade
            # Get current portfolio value for position sizing
            portfolio_value = self.get_portfolio_value()
            trade = PaperTrade(signal, current_price, portfolio_value)
            self.trades.append(trade)
            
            # Update portfolio
            self.portfolio['total_trades'] += 1
            self.portfolio['open_trades'] += 1
            self.portfolio['last_updated'] = datetime.now().isoformat()
            
            self.save_data()
            return trade
            
        except Exception as e:
            print(f"Error creating trade: {e}")
            return None
    
    def get_current_price(self, symbol: str) -> float:
        """Get current price for symbol (mock implementation)"""
        # In production, fetch from Binance/Coinbase API
        base_prices = {
            'BTC/USDT': 50000 + random.uniform(-1000, 1000),
            'ETH/USDT': 3000 + random.uniform(-100, 100),
            'SOL/USDT': 150 + random.uniform(-10, 10)
        }
        return base_prices.get(symbol, 100)
    
    def update_all_trades(self):
        """Update P&L for all open trades"""
        updated_trades = []
        
        for trade in self.trades:
            if trade.status == 'OPEN':
                current_price = self.get_current_price(trade.symbol)
                pnl, pnl_percent = trade.update_pnl(current_price)
                
                # If trade was closed by stop loss/take profit
                if trade.status != 'OPEN':
                    self.portfolio['open_trades'] -= 1
                    self.portfolio['total_pnl'] += pnl
                    self.portfolio['balance'] += pnl
                
                updated_trades.append(trade)
        
        self.portfolio['last_updated'] = datetime.now().isoformat()
        self.save_data()
        return updated_trades
    
    def close_trade(self, trade_id: str, exit_price: Optional[float] = None) -> Optional[PaperTrade]:
        """Close a specific trade"""
        for trade in self.trades:
            if trade.id == trade_id and trade.status == 'OPEN':
                if exit_price is None:
                    exit_price = self.get_current_price(trade.symbol)
                
                trade.close(exit_price, 'MANUAL')
                self.portfolio['open_trades'] -= 1
                self.portfolio['total_pnl'] += trade.pnl
                self.portfolio['balance'] += trade.pnl
                self.portfolio['last_updated'] = datetime.now().isoformat()
                
                self.save_data()
                return trade
        
        return None
    
    def close_all_trades(self):
        """Close all open trades"""
        closed_trades = []
        
        for trade in self.trades:
            if trade.status == 'OPEN':
                exit_price = self.get_current_price(trade.symbol)
                trade.close(exit_price, 'MANUAL_CLOSE_ALL')
                self.portfolio['total_pnl'] += trade.pnl
                self.portfolio['balance'] += trade.pnl
                closed_trades.append(trade)
        
        self.portfolio['open_trades'] = 0
        self.portfolio['last_updated'] = datetime.now().isoformat()
        self.save_data()
        return closed_trades
    
    def get_stats(self) -> Dict:
        """Calculate trading statistics"""
        if not self.trades:
            return {
                'total_trades': 0,
                'win_rate': 0,
                'total_pnl': 0,
                'avg_win': 0,
                'avg_loss': 0,
                'largest_win': 0,
                'largest_loss': 0,
                'sharpe_ratio': 0,
                'balance': self.portfolio['balance'],
                'roi_percent': 0
            }
        
        closed_trades = [t for t in self.trades if t.status != 'OPEN']
        winning_trades = [t for t in closed_trades if t.pnl > 0]
        losing_trades = [t for t in closed_trades if t.pnl < 0]
        
        total_pnl = sum(t.pnl for t in closed_trades)
        win_rate = len(winning_trades) / len(closed_trades) * 100 if closed_trades else 0
        
        avg_win = sum(t.pnl for t in winning_trades) / len(winning_trades) if winning_trades else 0
        avg_loss = sum(t.pnl for t in losing_trades) / len(losing_trades) if losing_trades else 0
        
        largest_win = max((t.pnl for t in winning_trades), default=0)
        largest_loss = min((t.pnl for t in losing_trades), default=0)
        
        # Simple Sharpe ratio (assuming risk-free rate = 0)
        returns = [t.pnl_percent / 100 for t in closed_trades]  # Convert to decimal
        avg_return = sum(returns) / len(returns) if returns else 0
        std_return = (sum((r - avg_return) ** 2 for r in returns) / len(returns)) ** 0.5 if returns else 0
        sharpe_ratio = avg_return / std_return if std_return > 0 else 0
        
        roi_percent = ((self.portfolio['balance'] - self.portfolio['initial_balance']) / 
                      self.portfolio['initial_balance']) * 100
        
        stats = {
            'total_trades': len(closed_trades),
            'win_rate': round(win_rate, 1),
            'total_pnl': round(total_pnl, 2),
            'avg_win': round(avg_win, 2),
            'avg_loss': round(avg_loss, 2),
            'largest_win': round(largest_win, 2),
            'largest_loss': round(largest_loss, 2),
            'sharpe_ratio': round(sharpe_ratio, 2),
            'balance': round(self.portfolio['balance'], 2),
            'roi_percent': round(roi_percent, 2),
            'open_trades': self.portfolio['open_trades']
        }
        
        # Save stats
        self.stats = stats
        self.save_data()
        
        return stats
    
    def get_open_trades(self) -> List[PaperTrade]:
        """Get all open trades"""
        return [t for t in self.trades if t.status == 'OPEN']
    
    def get_trade_history(self, limit: int = 20) -> List[PaperTrade]:
        """Get recent trade history"""
        closed_trades = [t for t in self.trades if t.status != 'OPEN']
        return sorted(closed_trades, key=lambda x: x.exit_time or x.entry_time, reverse=True)[:limit]
    
    def reset_portfolio(self, new_balance: float = 10000.0):
        """Reset portfolio to initial state"""
        self.trades = []
        self.stats = {}
        self.portfolio = {
            'balance': new_balance,
            'initial_balance': new_balance,
            'last_updated': datetime.now().isoformat(),
            'total_trades': 0,
            'open_trades': 0,
            'total_pnl': 0.0
        }
        self.save_data()


# Singleton instance
tracker = PaperTradingTracker()

if __name__ == "__main__":
    # Test the tracker
    test_signal = {
        'id': 'test_signal_001',
        'symbol': 'BTC/USDT',
        'direction': 'LONG',
        'confidence': 0.8,
        'source': 'TEST'
    }
    
    trade = tracker.create_trade(test_signal)
    print(f"Created trade: {trade.id}")
    
    stats = tracker.get_stats()
    print(f"Stats: {stats}")
    
    open_trades = tracker.get_open_trades()
    print(f"Open trades: {len(open_trades)}")