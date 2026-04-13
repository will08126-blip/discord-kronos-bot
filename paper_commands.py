"""
Paper Trading Discord Commands
Integrates paper trading with Discord slash commands
"""

import json
from datetime import datetime
from paper_tracker import tracker
from typing import Dict, List

def format_trade_embed(trade) -> Dict:
    """Format trade as Discord embed"""
    status_emoji = {
        'OPEN': '🟢',
        'TAKE_PROFIT': '💰',
        'STOP_LOSS': '🛑',
        'MANUAL': '👋',
        'MANUAL_CLOSE_ALL': '📦'
    }.get(trade.status, '❓')
    
    direction_emoji = '📈' if trade.direction == 'LONG' else '📉'
    pnl_emoji = '🟢' if trade.pnl >= 0 else '🔴'
    
    embed = {
        "title": f"{direction_emoji} Paper Trade: {trade.symbol}",
        "color": 0x00FF00 if trade.pnl >= 0 else 0xFF0000,
        "fields": [
            {"name": "ID", "value": trade.id[:8], "inline": True},
            {"name": "Direction", "value": trade.direction, "inline": True},
            {"name": "Status", "value": f"{status_emoji} {trade.status}", "inline": True},
            {"name": "Entry Price", "value": f"${trade.entry_price:,.2f}", "inline": True},
            {"name": "Exit Price", "value": f"${trade.exit_price:,.2f}" if trade.exit_price else "N/A", "inline": True},
            {"name": "Leverage", "value": f"{trade.leverage}x", "inline": True},
            {"name": "P&L", "value": f"{pnl_emoji} ${trade.pnl:,.2f} ({trade.pnl_percent:+.2f}%)", "inline": True},
            {"name": "Confidence", "value": f"{trade.confidence*100:.1f}%", "inline": True},
            {"name": "Duration", "value": calculate_duration(trade.entry_time, trade.exit_time), "inline": True}
        ],
        "timestamp": trade.exit_time or trade.entry_time,
        "footer": {"text": f"Source: {trade.source}"}
    }
    
    return embed

def format_stats_embed(stats: Dict) -> Dict:
    """Format stats as Discord embed"""
    win_rate_emoji = '🎯' if stats['win_rate'] >= 60 else '⚠️' if stats['win_rate'] >= 40 else '💀'
    pnl_emoji = '💰' if stats['total_pnl'] >= 0 else '💸'
    roi_emoji = '🚀' if stats['roi_percent'] >= 10 else '📈' if stats['roi_percent'] >= 0 else '📉'
    
    embed = {
        "title": "📊 Paper Trading Statistics",
        "color": 0x0099FF,
        "fields": [
            {"name": "Balance", "value": f"${stats['balance']:,.2f}", "inline": True},
            {"name": "ROI", "value": f"{roi_emoji} {stats['roi_percent']:+.2f}%", "inline": True},
            {"name": "Total P&L", "value": f"{pnl_emoji} ${stats['total_pnl']:,.2f}", "inline": True},
            {"name": "Win Rate", "value": f"{win_rate_emoji} {stats['win_rate']:.1f}%", "inline": True},
            {"name": "Total Trades", "value": f"{stats['total_trades']}", "inline": True},
            {"name": "Open Trades", "value": f"{stats['open_trades']}", "inline": True},
            {"name": "Avg Win", "value": f"${stats['avg_win']:,.2f}", "inline": True},
            {"name": "Avg Loss", "value": f"${stats['avg_loss']:,.2f}", "inline": True},
            {"name": "Sharpe Ratio", "value": f"{stats['sharpe_ratio']:.2f}", "inline": True},
            {"name": "Largest Win", "value": f"${stats['largest_win']:,.2f}", "inline": True},
            {"name": "Largest Loss", "value": f"${stats['largest_loss']:,.2f}", "inline": True}
        ],
        "timestamp": datetime.now().isoformat(),
        "footer": {"text": "Kronos AI Paper Trading • Updated every trade"}
    }
    
    return embed

def format_portfolio_embed(open_trades: List, stats: Dict) -> Dict:
    """Format portfolio as Discord embed"""
    if not open_trades:
        return {
            "title": "📭 No Open Paper Trades",
            "description": "No active paper trades. Wait for Kronos signals or use `/paper-buy` to enter manually.",
            "color": 0x666666,
            "timestamp": datetime.now().isoformat()
        }
    
    # Calculate total unrealized P&L
    total_unrealized = sum(t.pnl for t in open_trades)
    total_unrealized_percent = sum(t.pnl_percent for t in open_trades) / len(open_trades) if open_trades else 0
    
    fields = []
    for i, trade in enumerate(open_trades[:10]):  # Limit to 10 trades
        pnl_emoji = '🟢' if trade.pnl >= 0 else '🔴'
        fields.append({
            "name": f"{i+1}. {trade.symbol} ({trade.direction})",
            "value": f"Entry: ${trade.entry_price:,.2f} • P&L: {pnl_emoji} ${trade.pnl:,.2f} ({trade.pnl_percent:+.2f}%)",
            "inline": False
        })
    
    if len(open_trades) > 10:
        fields.append({
            "name": "Note",
            "value": f"... and {len(open_trades) - 10} more trades",
            "inline": False
        })
    
    embed = {
        "title": "📦 Paper Trading Portfolio",
        "color": 0x00AAFF,
        "fields": fields,
        "description": f"**Total Unrealized P&L:** ${total_unrealized:,.2f} ({total_unrealized_percent:+.2f}%)\n**Balance:** ${stats['balance']:,.2f}",
        "timestamp": datetime.now().isoformat(),
        "footer": {"text": f"{len(open_trades)} open trades • Use /paper-close [id] to close"}
    }
    
    return embed

def format_history_embed(history: List) -> Dict:
    """Format trade history as Discord embed"""
    if not history:
        return {
            "title": "📜 No Trade History",
            "description": "No completed paper trades yet.",
            "color": 0x666666,
            "timestamp": datetime.now().isoformat()
        }
    
    fields = []
    for i, trade in enumerate(history[:5]):  # Limit to 5 recent trades
        status_emoji = {
            'TAKE_PROFIT': '💰',
            'STOP_LOSS': '🛑',
            'MANUAL': '👋'
        }.get(trade.status, '❓')
        
        pnl_emoji = '🟢' if trade.pnl >= 0 else '🔴'
        direction_emoji = '📈' if trade.direction == 'LONG' else '📉'
        
        fields.append({
            "name": f"{i+1}. {direction_emoji} {trade.symbol}",
            "value": f"{status_emoji} {trade.status} • P&L: {pnl_emoji} ${trade.pnl:,.2f} • {calculate_duration(trade.entry_time, trade.exit_time)}",
            "inline": False
        })
    
    embed = {
        "title": "📜 Recent Trade History",
        "color": 0xAA00FF,
        "fields": fields,
        "description": f"Showing {len(history[:5])} most recent trades",
        "timestamp": datetime.now().isoformat(),
        "footer": {"text": f"Total trades: {len(history)} • Win rate: {tracker.get_stats()['win_rate']:.1f}%"}
    }
    
    return embed

def calculate_duration(start_time: str, end_time: str = None) -> str:
    """Calculate duration between two timestamps"""
    try:
        start = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        end = datetime.fromisoformat(end_time.replace('Z', '+00:00')) if end_time else datetime.now()
        
        duration = end - start
        hours = duration.total_seconds() / 3600
        
        if hours < 1:
            return f"{int(duration.total_seconds() / 60)}m"
        elif hours < 24:
            return f"{hours:.1f}h"
        else:
            return f"{hours/24:.1f}d"
    except:
        return "N/A"

# Command handlers for Discord
def handle_paper_start(balance: float = 2000.0):  # Default $2000
    """Start paper trading with initial balance"""
    tracker.reset_portfolio(balance)
    stats = tracker.get_stats()
    
    return {
        "embeds": [{
            "title": "🚀 Paper Trading Started!",
            "description": f"Virtual account created with **${balance:,.2f}** balance.",
            "color": 0x00FF00,
            "fields": [
                {"name": "Initial Balance", "value": f"${balance:,.2f}", "inline": True},
                {"name": "Trade Size", "value": "Dynamic: 4% risk, 1% SL / 2% TP, smart leverage", "inline": True},
                {"name": "Leverage", "value": "1-25x (based on confidence)", "inline": True}
            ],
            "timestamp": datetime.now().isoformat(),
            "footer": {"text": "Kronos signals will auto-create paper trades"}
        }]
    }

def handle_paper_stats():
    """Get paper trading statistics"""
    tracker.update_all_trades()  # Update P&L first
    stats = tracker.get_stats()
    
    return {
        "embeds": [format_stats_embed(stats)]
    }

def handle_paper_portfolio():
    """Get open paper trades"""
    tracker.update_all_trades()  # Update P&L first
    open_trades = tracker.get_open_trades()
    stats = tracker.get_stats()
    
    return {
        "embeds": [format_portfolio_embed(open_trades, stats)]
    }

def handle_paper_history(limit: int = 10):
    """Get trade history"""
    history = tracker.get_trade_history(limit)
    
    return {
        "embeds": [format_history_embed(history)]
    }

def handle_paper_close(trade_id: str = None):
    """Close paper trade(s)"""
    if trade_id:
        # Close specific trade
        trade = tracker.close_trade(trade_id)
        if trade:
            return {
                "embeds": [{
                    "title": "✅ Trade Closed",
                    "description": f"Closed paper trade **{trade_id[:8]}**",
                    "color": 0x00FF00,
                    "fields": [
                        {"name": "Symbol", "value": trade.symbol, "inline": True},
                        {"name": "P&L", "value": f"${trade.pnl:,.2f} ({trade.pnl_percent:+.2f}%)", "inline": True},
                        {"name": "Duration", "value": calculate_duration(trade.entry_time, trade.exit_time), "inline": True}
                    ],
                    "timestamp": datetime.now().isoformat()
                }]
            }
        else:
            return {
                "content": f"❌ Trade {trade_id} not found or already closed."
            }
    else:
        # Close all trades
        closed_trades = tracker.close_all_trades()
        return {
            "embeds": [{
                "title": "📦 All Trades Closed",
                "description": f"Closed **{len(closed_trades)}** paper trades.",
                "color": 0xFF9900,
                "fields": [
                    {"name": "Total P&L", "value": f"${sum(t.pnl for t in closed_trades):,.2f}", "inline": True},
                    {"name": "New Balance", "value": f"${tracker.portfolio['balance']:,.2f}", "inline": True},
                    {"name": "Open Trades", "value": "0", "inline": True}
                ],
                "timestamp": datetime.now().isoformat()
            }]
        }

def handle_paper_reset(confirm: bool = False):
    """Reset paper trading portfolio"""
    if not confirm:
        return {
            "embeds": [{
                "title": "⚠️ Confirm Reset",
                "description": "This will delete ALL paper trading data and start fresh.",
                "color": 0xFF0000,
                "fields": [
                    {"name": "Current Balance", "value": f"${tracker.portfolio['balance']:,.2f}", "inline": True},
                    {"name": "Total Trades", "value": str(tracker.portfolio['total_trades']), "inline": True},
                    {"name": "Action", "value": "Use `/paper-reset confirm:true` to confirm", "inline": False}
                ],
                "timestamp": datetime.now().isoformat(),
                "footer": {"text": "This action cannot be undone!"}
            }]
        }
    
    old_balance = tracker.portfolio['balance']
    tracker.reset_portfolio()
    
    return {
        "embeds": [{
            "title": "🔄 Portfolio Reset",
            "description": "Paper trading portfolio has been reset.",
            "color": 0x00FF00,
            "fields": [
                {"name": "Old Balance", "value": f"${old_balance:,.2f}", "inline": True},
                {"name": "New Balance", "value": "$10,000.00", "inline": True},
                {"name": "Status", "value": "Ready for new trades", "inline": True}
            ],
            "timestamp": datetime.now().isoformat(),
            "footer": {"text": "Use /paper-start to begin trading"}
        }]
    }

def handle_paper_buy(symbol: str, direction: str, confidence: float = 0.7):
    """Manually enter a paper trade"""
    signal = {
        'id': f"manual_{int(datetime.now().timestamp())}",
        'symbol': symbol,
        'direction': direction.upper(),
        'confidence': confidence,
        'source': 'MANUAL'
    }
    
    trade = tracker.create_trade(signal)
    if trade:
        return {
            "embeds": [format_trade_embed(trade)]
        }
    else:
        return {
            "content": "❌ Failed to create paper trade."
        }

# Auto-tracking function for Kronos signals
def auto_track_kronos_signal(signal: Dict):
    """Automatically create paper trade for Kronos signal"""
    if signal.get('confidence', 0) >= 0.7:  # Only track high-confidence signals
        trade = tracker.create_trade(signal)
        if trade:
            print(f"📝 Auto-created paper trade for {signal['symbol']}: {trade.id}")
            return trade
    return None

if __name__ == "__main__":
    # Test the commands
    print("Testing paper commands...")
    
    # Start paper trading
    result = handle_paper_start()
    print("Start:", json.dumps(result, indent=2)[:200] + "...")
    
    # Create a test trade
    test_signal = {
        'id': 'test_signal_001',
        'symbol': 'BTC/USDT',
        'direction': 'LONG',
        'confidence': 0.85,
        'source': 'KRONOS'
    }
    
    trade = auto_track_kronos_signal(test_signal)
    if trade:
        print(f"Created trade: {trade.id}")
    
    # Get stats
    result = handle_paper_stats()
    print("Stats:", json.dumps(result, indent=2)[:200] + "...")
    
    # Get portfolio
    result = handle_paper_portfolio()
    print("Portfolio:", json.dumps(result, indent=2)[:200] + "...")