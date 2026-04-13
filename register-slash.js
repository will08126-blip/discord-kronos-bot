/**
 * Register Slash Commands for Kronos Bot
 * Run once: node register-slash.js
 */

require('dotenv').config();

const { REST, Routes } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.APPLICATION_ID;
const GUILD_ID = process.env.SERVER_ID;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ Missing environment variables');
  console.error('Need: DISCORD_TOKEN, APPLICATION_ID, SERVER_ID');
  process.exit(1);
}

// Define slash commands
const commands = [
  {
    name: 'kronos',
    description: 'Kronos AI trading commands',
    options: [
      {
        name: 'action',
        description: 'What action to perform',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'Start scanning', value: 'start' },
          { name: 'Stop scanning', value: 'stop' },
          { name: 'Show status', value: 'status' },
          { name: 'Send test signal', value: 'test' },
          { name: 'Show help', value: 'help' }
        ]
      }
    ]
  },
  {
    name: 'scan',
    description: 'Start Kronos AI scanning',
  },
  {
    name: 'stop',
    description: 'Stop Kronos scanning',
  },
  {
    name: 'status',
    description: 'Show Kronos bot status',
  },
  {
    name: 'test',
    description: 'Send test Kronos signal',
  },
  {
    name: 'help',
    description: 'Show Kronos bot help',
  },
  {
    name: 'predict',
    description: 'Get Kronos prediction for a symbol',
    options: [
      {
        name: 'symbol',
        description: 'Trading symbol (e.g., BTC/USDT)',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'BTC/USDT', value: 'BTC/USDT' },
          { name: 'ETH/USDT', value: 'ETH/USDT' },
          { name: 'SOL/USDT', value: 'SOL/USDT' }
        ]
      },
      {
        name: 'timeframe',
        description: 'Timeframe for prediction',
        type: 3, // STRING
        required: false,
        choices: [
          { name: '1 minute', value: '1m' },
          { name: '5 minutes', value: '5m' },
          { name: '15 minutes', value: '15m' },
          { name: '1 hour', value: '1h' },
          { name: '4 hours', value: '4h' }
        ]
      }
    ]
  },
  // Paper Trading Commands
  {
    name: 'paper-start',
    description: 'Start paper trading with virtual account',
    options: [
      {
        name: 'balance',
        description: 'Starting balance (default: $10,000)',
        type: 10, // NUMBER
        required: false,
        min_value: 1000,
        max_value: 1000000
      }
    ]
  },
  {
    name: 'paper-stats',
    description: 'Show paper trading statistics',
  },
  {
    name: 'paper-portfolio',
    description: 'Show open paper trades',
  },
  {
    name: 'paper-history',
    description: 'Show paper trade history',
    options: [
      {
        name: 'limit',
        description: 'Number of trades to show (default: 10)',
        type: 4, // INTEGER
        required: false,
        min_value: 1,
        max_value: 50
      }
    ]
  },
  {
    name: 'paper-close',
    description: 'Close paper trade(s)',
    options: [
      {
        name: 'trade_id',
        description: 'Trade ID to close (leave empty to close all)',
        type: 3, // STRING
        required: false
      }
    ]
  },
  {
    name: 'paper-reset',
    description: 'Reset paper trading portfolio',
    options: [
      {
        name: 'confirm',
        description: 'Confirm reset (required)',
        type: 5, // BOOLEAN
        required: false
      }
    ]
  },
  {
    name: 'paper-buy',
    description: 'Manually enter a paper trade',
    options: [
      {
        name: 'symbol',
        description: 'Trading symbol',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'BTC/USDT', value: 'BTC/USDT' },
          { name: 'ETH/USDT', value: 'ETH/USDT' },
          { name: 'SOL/USDT', value: 'SOL/USDT' }
        ]
      },
      {
        name: 'direction',
        description: 'Trade direction',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'LONG', value: 'LONG' },
          { name: 'SHORT', value: 'SHORT' }
        ]
      },
      {
        name: 'confidence',
        description: 'Confidence level (0.1-1.0)',
        type: 10, // NUMBER
        required: false,
        min_value: 0.1,
        max_value: 1.0
      }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering slash commands...');
    
    // Register guild-specific commands (faster, doesn't require global cache)
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    
    console.log('✅ Slash commands registered successfully!');
    console.log('\n📋 Available commands:');
    console.log('  /kronos [action]  - Main Kronos command');
    console.log('  /scan             - Start scanning');
    console.log('  /stop             - Stop scanning');
    console.log('  /status           - Show status');
    console.log('  /test             - Send test signal');
    console.log('  /help             - Show help');
    console.log('  /predict [symbol] - Get prediction for symbol');
    
    console.log('\n⚠️  Note: It may take a few minutes for commands to appear in Discord.');
    console.log('   Type "/" in your Discord channel to see available commands.');
    
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
})();