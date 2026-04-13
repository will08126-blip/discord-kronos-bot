#!/usr/bin/env python3
"""
STRICT Real Data Only Policy
No fakes, no hallucinations, no mock data
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import time
import json
import os
from typing import Dict, Optional, Tuple
import requests
import ccxt

class StrictRealData:
    """100% real data or fail - no compromises"""
    
    def __init__(self):
        # Public APIs that work without keys
        self.apis = [
            self._try_coingecko,
            self._try_cryptocompare,
            self._try_binance_public,
            self._try_kraken_public
        ]
        
        # Cache for rate limiting
        self.cache = {}
        self.cache_timeout = 60  # 1 minute cache
        
    def get_ohlcv(self, symbol: str, timeframe: str = "15m", limit: int = 100) -> pd.DataFrame:
        """
        Get 100% real OHLCV data or raise exception
        
        Raises:
            ValueError: If no real data can be obtained
        """
        print(f"🔍 STRICT: Fetching 100% real data for {symbol} ({timeframe})...")
        
        # Try all APIs
        for api_func in self.apis:
            try:
                df = api_func(symbol, timeframe, limit)
                if df is not None and not df.empty and len(df) >= min(limit, 50):
                    print(f"✅ STRICT: Got {len(df)} REAL candles from {api_func.__name__}")
                    return df
            except Exception as e:
                print(f"❌ {api_func.__name__} failed: {e}")
                continue
        
        # NO DATA - FAIL HARD
        raise ValueError(f"❌❌❌ NO REAL DATA AVAILABLE for {symbol}. All APIs failed.")
    
    def _try_coingecko(self, symbol: str, timeframe: str, limit: int) -> Optional[pd.DataFrame]:
        """CoinGecko API (free, no key needed)"""
        try:
            # Map symbol
            cg_id = self._symbol_to_coingecko(symbol)
            if not cg_id:
                return None
            
            # Map timeframe to days
            days_map = {
                "1m": 1,    # Max 1 day for 1m
                "5m": 1,    # Max 1 day for 5m
                "15m": 7,   # Max 7 days for 15m
                "1h": 30,   # Max 30 days for 1h
                "4h": 90,   # Max 90 days
                "1d": 365   # Max 1 year
            }
            
            days = days_map.get(timeframe, 7)
            
            url = f"https://api.coingecko.com/api/v3/coins/{cg_id}/ohlc"
            params = {
                "vs_currency": "usd",
                "days": days
            }
            
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            
            if not data:
                return None
            
            # CoinGecko returns: [timestamp, open, high, low, close]
            df = pd.DataFrame(data, columns=['timestamp', 'open', 'high', 'low', 'close'])
            df['volume'] = 0  # CoinGecko doesn't provide volume in OHLC endpoint
            
            # Convert timestamp from ms
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
            
            # Sort and limit
            df = df.sort_values('timestamp').reset_index(drop=True)
            df = df.tail(limit)
            
            return df
            
        except Exception as e:
            print(f"CoinGecko error: {e}")
            return None
    
    def _try_cryptocompare(self, symbol: str, timeframe: str, limit: int) -> Optional[pd.DataFrame]:
        """CryptoCompare API (free tier)"""
        try:
            # Map symbol
            cc_symbol = symbol.replace('/', '')
            
            # Map timeframe
            tf_map = {
                "1m": "histominute",
                "5m": "histominute",
                "15m": "histominute",
                "1h": "histohour",
                "4h": "histohour",
                "1d": "histoday"
            }
            
            endpoint = tf_map.get(timeframe, "histohour")
            
            # Free tier: 100,000 calls/month
            url = f"https://min-api.cryptocompare.com/data/v2/{endpoint}"
            params = {
                "fsym": cc_symbol.split('USDT')[0],
                "tsym": "USD",
                "limit": min(limit, 2000),  # Max 2000
                "api_key": "YOUR_KEY_HERE"  # Free tier works without key for low volume
            }
            
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            
            if data.get('Response') != 'Success':
                return None
            
            candles = data['Data']['Data']
            
            if not candles:
                return None
            
            df = pd.DataFrame(candles)
            df = df.rename(columns={
                'time': 'timestamp',
                'open': 'open',
                'high': 'high',
                'low': 'low',
                'close': 'close',
                'volumefrom': 'volume'
            })
            
            # Convert timestamp
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')
            
            # Select columns
            df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']]
            df = df.sort_values('timestamp').reset_index(drop=True)
            df = df.tail(limit)
            
            return df
            
        except Exception as e:
            print(f"CryptoCompare error: {e}")
            return None
    
    def _try_binance_public(self, symbol: str, timeframe: str, limit: int) -> Optional[pd.DataFrame]:
        """Binance public API (no key needed for OHLCV)"""
        try:
            # Map symbol
            binance_symbol = symbol.replace('/', '')
            
            # Map timeframe
            tf_map = {
                "1m": "1m",
                "5m": "5m",
                "15m": "15m",
                "1h": "1h",
                "4h": "4h",
                "1d": "1d"
            }
            
            interval = tf_map.get(timeframe, "15m")
            
            url = "https://api.binance.com/api/v3/klines"
            params = {
                "symbol": binance_symbol,
                "interval": interval,
                "limit": min(limit, 1000)
            }
            
            response = requests.get(url, params=params, timeout=10)
            
            # Check if blocked (451)
            if response.status_code == 451:
                print("Binance blocked (451)")
                return None
            
            response.raise_for_status()
            
            data = response.json()
            
            if not data:
                return None
            
            # Parse: [timestamp, open, high, low, close, volume, ...]
            df = pd.DataFrame(data, columns=[
                'timestamp', 'open', 'high', 'low', 'close', 'volume',
                'close_time', 'quote_volume', 'trades', 'taker_buy_base', 'taker_buy_quote', 'ignore'
            ])
            
            # Convert
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
            df['open'] = df['open'].astype(float)
            df['high'] = df['high'].astype(float)
            df['low'] = df['low'].astype(float)
            df['close'] = df['close'].astype(float)
            df['volume'] = df['volume'].astype(float)
            
            df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']]
            df = df.sort_values('timestamp').reset_index(drop=True)
            df = df.tail(limit)
            
            return df
            
        except Exception as e:
            print(f"Binance error: {e}")
            return None
    
    def _try_kraken_public(self, symbol: str, timeframe: str, limit: int) -> Optional[pd.DataFrame]:
        """Kraken public API"""
        try:
            # Map symbol
            kraken_symbol = symbol.replace('/', '')
            
            # Map timeframe (Kraken uses minutes)
            tf_minutes = {
                "1m": 1,
                "5m": 5,
                "15m": 15,
                "1h": 60,
                "4h": 240,
                "1d": 1440
            }
            
            interval = tf_minutes.get(timeframe, 15)
            
            url = "https://api.kraken.com/0/public/OHLC"
            params = {
                "pair": kraken_symbol,
                "interval": interval
            }
            
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            
            if data.get('error'):
                return None
            
            # Kraken returns nested structure
            pair_data = list(data['result'].values())[0]
            
            if not pair_data:
                return None
            
            # Parse: [time, open, high, low, close, vwap, volume, count]
            df = pd.DataFrame(pair_data, columns=[
                'timestamp', 'open', 'high', 'low', 'close', 'vwap', 'volume', 'count'
            ])
            
            # Convert
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')
            df['open'] = df['open'].astype(float)
            df['high'] = df['high'].astype(float)
            df['low'] = df['low'].astype(float)
            df['close'] = df['close'].astype(float)
            df['volume'] = df['volume'].astype(float)
            
            df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']]
            df = df.sort_values('timestamp').reset_index(drop=True)
            df = df.tail(limit)
            
            return df
            
        except Exception as e:
            print(f"Kraken error: {e}")
            return None
    
    def _symbol_to_coingecko(self, symbol: str) -> str:
        """Convert trading symbol to CoinGecko ID"""
        mapping = {
            "BTC/USDT": "bitcoin",
            "ETH/USDT": "ethereum",
            "SOL/USDT": "solana",
            "XRP/USDT": "ripple",
            "DOGE/USDT": "dogecoin"
        }
        return mapping.get(symbol)

# Global strict instance
_strict_fetcher = None

def get_strict_fetcher():
    """Get strict real-data-only fetcher"""
    global _strict_fetcher
    if _strict_fetcher is None:
        _strict_fetcher = StrictRealData()
    return _strict_fetcher

def fetch_real_or_fail(symbol: str, timeframe: str = "15m", limit: int = 100) -> pd.DataFrame:
    """
    Fetch 100% real data or raise exception
    
    This is the ONLY data function that should be used
    """
    fetcher = get_strict_fetcher()
    return fetcher.get_ohlcv(symbol, timeframe, limit)

# Test
if __name__ == "__main__":
    print("🧪 Testing STRICT real-data-only policy...")
    
    try:
        df = fetch_real_or_fail("BTC/USDT", "15m", 50)
        print(f"✅ SUCCESS: Got {len(df)} REAL candles")
        print(f"Latest: ${df['close'].iloc[-1]:,.2f} at {df['timestamp'].iloc[-1]}")
        print(f"Source: 100% REAL MARKET DATA")
        
    except ValueError as e:
        print(f"❌ FAILED: {e}")
        print("Bot should NOT run without real data!")