#!/usr/bin/env python3
"""
Mode Manager for Kronos Discord Bot
Manages trading modes (conservative/aggressive) and their parameters
"""

import json
import os
from typing import Dict, Any

class ModeManager:
    """Manages trading modes and their parameters"""
    
    def __init__(self, config_path: str = "mode_config.json"):
        self.config_path = config_path
        self.config = self.load_config()
    
    def load_config(self) -> Dict[str, Any]:
        """Load mode configuration from file"""
        default_config = {
            "current_mode": "conservative",
            "modes": {
                "conservative": {
                    "description": "Lower risk, more cautious trading",
                    "confidence_threshold": 0.75,
                    "min_leverage": 3,
                    "max_leverage": 10,
                    "stop_loss_percent": 0.02,
                    "take_profit_percent": 0.03,
                    "risk_per_trade_percent": 0.02,
                    "max_position_percent": 0.3,
                    "paper_tracking_enabled": True,
                    "auto_trade_enabled": False
                },
                "aggressive": {
                    "description": "Higher risk, more aggressive trading",
                    "confidence_threshold": 0.65,
                    "min_leverage": 10,
                    "max_leverage": 25,
                    "stop_loss_percent": 0.01,
                    "take_profit_percent": 0.02,
                    "risk_per_trade_percent": 0.04,
                    "max_position_percent": 0.5,
                    "paper_tracking_enabled": True,
                    "auto_trade_enabled": False
                }
            }
        }
        
        try:
            if os.path.exists(self.config_path):
                with open(self.config_path, 'r') as f:
                    config = json.load(f)
                    # Merge with defaults to ensure all fields exist
                    for mode in default_config["modes"]:
                        if mode in config["modes"]:
                            default_config["modes"][mode].update(config["modes"][mode])
                    config["modes"] = default_config["modes"]
                    return config
            else:
                # Create default config file
                self.save_config(default_config)
                return default_config
        except Exception as e:
            print(f"Error loading mode config: {e}")
            return default_config
    
    def save_config(self, config: Dict[str, Any] = None) -> bool:
        """Save mode configuration to file"""
        try:
            if config is None:
                config = self.config
            
            with open(self.config_path, 'w') as f:
                json.dump(config, f, indent=2)
            return True
        except Exception as e:
            print(f"Error saving mode config: {e}")
            return False
    
    def get_current_mode(self) -> str:
        """Get current trading mode"""
        return self.config.get("current_mode", "conservative")
    
    def get_mode_params(self, mode: str = None) -> Dict[str, Any]:
        """Get parameters for specified mode (or current mode if None)"""
        if mode is None:
            mode = self.get_current_mode()
        
        return self.config["modes"].get(mode, self.config["modes"]["conservative"])
    
    def set_mode(self, mode: str) -> bool:
        """Set current trading mode"""
        if mode not in self.config["modes"]:
            print(f"Invalid mode: {mode}. Available modes: {list(self.config['modes'].keys())}")
            return False
        
        self.config["current_mode"] = mode
        return self.save_config()
    
    def get_confidence_threshold(self) -> float:
        """Get confidence threshold for current mode"""
        return self.get_mode_params()["confidence_threshold"]
    
    def get_leverage_range(self) -> tuple:
        """Get leverage range (min, max) for current mode"""
        params = self.get_mode_params()
        return (params["min_leverage"], params["max_leverage"])
    
    def get_stop_loss_percent(self) -> float:
        """Get stop-loss percentage for current mode"""
        return self.get_mode_params()["stop_loss_percent"]
    
    def get_take_profit_percent(self) -> float:
        """Get take-profit percentage for current mode"""
        return self.get_mode_params()["take_profit_percent"]
    
    def get_risk_per_trade_percent(self) -> float:
        """Get risk per trade percentage for current mode"""
        return self.get_mode_params()["risk_per_trade_percent"]
    
    def get_max_position_percent(self) -> float:
        """Get maximum position percentage for current mode"""
        return self.get_mode_params()["max_position_percent"]
    
    def is_paper_tracking_enabled(self) -> bool:
        """Check if paper tracking is enabled for current mode"""
        return self.get_mode_params()["paper_tracking_enabled"]
    
    def is_auto_trade_enabled(self) -> bool:
        """Check if auto trading is enabled for current mode"""
        return self.get_mode_params()["auto_trade_enabled"]
    
    def get_all_modes(self) -> Dict[str, Dict]:
        """Get all available modes and their parameters"""
        return self.config["modes"]
    
    def update_mode_params(self, mode: str, params: Dict[str, Any]) -> bool:
        """Update parameters for a specific mode"""
        if mode not in self.config["modes"]:
            return False
        
        self.config["modes"][mode].update(params)
        return self.save_config()


# Global instance
mode_manager = ModeManager()