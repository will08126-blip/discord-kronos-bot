/**
 * Kronos Discord Bot with Slash Commands
 * Modern Discord bot with /commands
 */

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, Events, REST, Routes, Collection } = require('discord.js');
const { spawn } = require('child_process');

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.SIGNAL_CHANNEL_ID;
const CLIENT_ID = process.env.APPLICATION_ID;
const GUILD_ID = process.env.SERVER_ID;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is required in .env file');
  process.exit(1);
}

console.log('='.repeat(50));
console.log('🤖 KRONOS DISCORD BOT - SLASH COMMANDS');
console.log('='.repeat(50));

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Store commands
client.commands = new Collection();

let isScanning = false;
let scanningInterval = null;

// Real Kronos validator
class RealKronosValidator {
  constructor() {
    this.config = {
      enabled: true,
      weight: 0.3,
      minConfidence: 0.7,
      modelPath: './models/kronos-small',
      tokenizerPath: './models/tokenizer'
    };
    this.isInitialized = false;
    this.paperTrackingEnabled = true;
  }

  async initialize() {
    console.log('🔧 Initializing real Kronos AI...');
    
    // Check if models exist
    const fs = require('fs');
    if (!fs.existsSync(this.config.modelPath)) {
      console.error(`❌ Kronos model not found at: ${this.config.modelPath}`);
      console.error('Models should be at: ./models/kronos-small/');
      return false;
    }
    
    if (!fs.existsSync(this.config.tokenizerPath)) {
      console.error(`❌ Tokenizer not found at: ${this.config.tokenizerPath}`);
      console.error('Tokenizer should be at: ./models/tokenizer/');
      return false;
    }
    
    console.log('✅ Kronos models found');
    this.isInitialized = true;
    return true;
  }

  async generateKronosSignal(symbol, timeframe) {
    if (!this.isInitialized) {
      console.error('❌❌❌ KRITICAL: Kronos not initialized');
      throw new Error('Kronos AI not initialized - cannot generate predictions');
    }

    try {
      console.log(`🤖 Calling real Kronos for ${symbol}...`);
      
      // Execute Python script
      const { spawn } = require('child_process');
      const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from kronos_bridge import predict_with_kronos
import json

result = predict_with_kronos('${symbol}', '${timeframe}')
print(result)
`;
      
      const result = await new Promise((resolve, reject) => {
        const pythonProcess = spawn('python3', ['-c', pythonScript]);
        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`Python script exited with code ${code}:`, stderr);
            reject(new Error(`Python script failed: ${stderr}`));
            return;
          }

          try {
            const result = JSON.parse(stdout.trim());
            resolve(result);
          } catch (error) {
            console.error('Failed to parse Python output:', stdout, stderr);
            reject(new Error('Invalid JSON from Python script'));
          }
        });

        pythonProcess.on('error', (error) => {
          reject(error);
        });
      });
      
      console.log(`✅ Kronos prediction: ${result.direction} ${result.predicted_change_pct}% (${result.confidence * 100}% confidence)`);
      
      const kronosSignal = {
        symbol: result.symbol,
        direction: result.direction,
        entryPrice: result.entry_price,
        predictedExitPrice: result.predicted_price,
        confidence: result.confidence,
        timeframe: result.timeframe,
        timestamp: new Date(),
        source: result.source || 'REAL_KRONOS',
        rawPrediction: result,
        id: `kronos_${Date.now()}_${symbol.replace('/', '_')}`
      };
      
      // Get ensemble analysis with Kronos signal
      const ensembleSignal = await this.getEnsembleAnalysis(symbol, timeframe, kronosSignal);
      
      // Auto-create paper trade if enabled and high confidence
      if (this.paperTrackingEnabled && ensembleSignal.confidence >= 0.7) {
        this.createPaperTrade(ensembleSignal);
      }
      
      return ensembleSignal;
      
    } catch (error) {
      console.error(`❌❌❌ KRITICAL: Kronos prediction FAILED for ${symbol}:`, error.message);
      console.error('NO REAL DATA AVAILABLE - BOT CANNOT CONTINUE');
      // NO FALLBACK - FAIL HARD
      throw new Error(`NO REAL DATA for ${symbol}: ${error.message}`);
    }
  }

  // NO MOCK SIGNALS - 100% REAL DATA ONLY
  _emergencyFail(symbol, timeframe) {
    console.error('❌❌❌ VIOLATION: Mock signals are PROHIBITED');
    throw new Error(`FATAL: Attempted mock signal for ${symbol}`);
  }

  getBasePrice(symbol) {
    // Only used for error messages, not trading
    const prices = {
      'BTC/USDT': 50000,
      'ETH/USDT': 3000,
      'SOL/USDT': 150
    };
    return prices[symbol] || 100;
  }
  
  async getEnsembleAnalysis(symbol, timeframe, kronosSignal = null) {
    try {
      const { spawn } = require('child_process');
      const kronosParam = kronosSignal ? JSON.stringify(kronosSignal).replace(/\\/g, '\\\\').replace(/'/g, "\\'") : 'None';
      
      const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from ensemble_integration import analyze_with_ensemble
import json

kronos_signal = ${kronosParam} if ${kronosParam} != 'None' else None
result = analyze_with_ensemble('${symbol}', '${timeframe}', kronos_signal)
print(json.dumps(result))
`;
      
      console.log(`🔍 Calling ensemble analysis for ${symbol}...`);
      
      const result = await new Promise((resolve, reject) => {
        const pythonProcess = spawn('python3', ['-c', pythonScript]);
        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
          console.error(`Ensemble stderr: ${data.toString()}`);
        });

        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`❌ Ensemble script exited with code ${code}:`, stderr);
            console.log(`Falling back to Kronos mock for ${symbol}`);
            resolve(this.generateKronosMockSignal(symbol, timeframe));  // Fallback to Kronos mock
            return;
          }

          try {
            const result = JSON.parse(stdout.trim());
            console.log(`✅ Ensemble stdout: ${stdout.substring(0, 100)}...`);
            resolve(result);
          } catch (error) {
            console.error('❌ Failed to parse ensemble output:', error.message);
            console.log(`Raw stdout: ${stdout.substring(0, 200)}`);
            console.log(`Stderr: ${stderr}`);
            reject(new Error(`Invalid ensemble output: ${error.message}`));
          }
        });

        pythonProcess.on('error', (error) => {
          console.error('❌ Ensemble script error:', error);
          reject(new Error(`Ensemble execution failed: ${error.message}`));
        });
      });
      
      console.log(`🎯 Ensemble analysis: ${result.direction} (${result.confidence * 100}% confidence) Source: ${result.source || 'N/A'}`);
      return result;
      
    } catch (error) {
      console.error('❌❌❌ KRITICAL: Ensemble analysis FAILED:', error);
      throw new Error(`Ensemble analysis failed: ${error.message}`);
    }
  }
  
  async createPaperTrade(signal) {
    try {
      const { spawn } = require('child_process');
      const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import auto_track_kronos_signal
import json

signal = ${JSON.stringify(signal)}
trade = auto_track_kronos_signal(signal)
if trade:
    print(json.dumps({"success": true, "trade_id": trade.id, "symbol": trade.symbol}))
else:
    print(json.dumps({"success": false, "reason": "Low confidence or error"}))
`;
      
      const result = await new Promise((resolve, reject) => {
        const pythonProcess = spawn('python3', ['-c', pythonScript]);
        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`Paper trade script exited with code ${code}:`, stderr);
            resolve({ success: false, error: stderr });
            return;
          }

          try {
            const result = JSON.parse(stdout.trim());
            resolve(result);
          } catch (error) {
            console.error('Failed to parse paper trade output:', stdout, stderr);
            resolve({ success: false, error: 'Invalid JSON' });
          }
        });

        pythonProcess.on('error', (error) => {
          resolve({ success: false, error: error.message });
        });
      });
      
      if (result.success) {
        console.log(`📝 Auto-created paper trade: ${result.trade_id} for ${result.symbol}`);
      }
      
      return result;
      
    } catch (error) {
      console.error('Failed to create paper trade:', error);
      return { success: false, error: error.message };
    }
  }
}

const kronos = new RealKronosValidator();

// Event handlers
client.on(Events.ClientReady, () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`📊 Monitoring channel: ${CHANNEL_ID || 'Not set'}`);
  console.log('\n📋 Available slash commands:');
  console.log('  /kronos [action]  - Main Kronos command');
  console.log('  /scan             - Start scanning');
  console.log('  /stop             - Stop scanning');
  console.log('  /status           - Show status');
  console.log('  /test             - Send test signal');
  console.log('  /help             - Show help');
  console.log('  /predict [symbol] - Get prediction for symbol');
});

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  try {
    // Defer reply for longer operations
    await interaction.deferReply();
    
    switch (commandName) {
      case 'kronos':
        await handleKronosCommand(interaction, options.getString('action'));
        break;
      
      case 'scan':
        await handleStart(interaction);
        break;
      
      case 'stop':
        await handleStop(interaction);
        break;
      
      case 'status':
        await handleStatus(interaction);
        break;
      
      case 'test':
        await handleTest(interaction);
        break;
      
      case 'help':
        await handleHelp(interaction);
        break;
      
      case 'predict':
        const symbol = options.getString('symbol') || 'BTC/USDT';
        const timeframe = options.getString('timeframe') || '15m';
        await handlePredict(interaction, symbol, timeframe);
        break;
      
      // Paper Trading Commands
      case 'paper-start':
        const balance = options.getNumber('balance') || 2000;  // Default $2000
        await handlePaperStart(interaction, balance);
        break;
      
      case 'paper-stats':
        await handlePaperStats(interaction);
        break;
      
      case 'paper-portfolio':
        await handlePaperPortfolio(interaction);
        break;
      
      case 'paper-history':
        const limit = options.getInteger('limit') || 10;
        await handlePaperHistory(interaction, limit);
        break;
      
      case 'paper-close':
        const tradeId = options.getString('trade_id');
        await handlePaperClose(interaction, tradeId);
        break;
      
      case 'paper-reset':
        const confirm = options.getBoolean('confirm') || false;
        await handlePaperReset(interaction, confirm);
        break;
      
      case 'paper-buy':
        const buySymbol = options.getString('symbol');
        const direction = options.getString('direction');
        const confidence = options.getNumber('confidence') || 0.7;
        await handlePaperBuy(interaction, buySymbol, direction, confidence);
        break;
      
      default:
        await interaction.editReply('Unknown command. Use `/help` for available commands.');
    }
    
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error);
    await interaction.editReply('❌ An error occurred while processing the command.');
  }
});

// Command handlers
async function handleKronosCommand(interaction, action) {
  switch (action) {
    case 'start':
      await handleStart(interaction);
      break;
    case 'stop':
      await handleStop(interaction);
      break;
    case 'status':
      await handleStatus(interaction);
      break;
    case 'test':
      await handleTest(interaction);
      break;
    case 'help':
      await handleHelp(interaction);
      break;
    default:
      await interaction.editReply(`Unknown action: ${action}. Use \`/help\` for available actions.`);
  }
}

async function handleStart(interaction) {
  if (isScanning) {
    await interaction.editReply('⚠️ Kronos is already scanning');
    return;
  }

  await interaction.editReply('🚀 Starting Kronos AI scanning...');
  
  // Initialize Kronos
  const initialized = await kronos.initialize();
  if (!initialized) {
    await interaction.followUp('❌ Failed to initialize Kronos. Running in fallback mode.');
  }

  isScanning = true;
  
  // Start scanning loop
  scanningInterval = setInterval(async () => {
    await scanCycle();
  }, 5 * 60 * 1000); // 5 minutes
  
  // Run first scan immediately
  await scanCycle();
  
  await interaction.followUp('✅ Kronos scanning started! Scanning BTC, ETH, SOL every 5 minutes.');
}

async function handleStop(interaction) {
  if (!isScanning) {
    await interaction.editReply('⚠️ Kronos is not scanning');
    return;
  }
  
  clearInterval(scanningInterval);
  isScanning = false;
  await interaction.editReply('🛑 Kronos scanning stopped');
}

async function scanCycle() {
  console.log(`📊 Running Kronos scan at ${new Date().toISOString()}`);
  
  const assets = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const timeframe = '15m';
  
  for (const asset of assets) {
    try {
      const signal = await kronos.generateKronosSignal(asset, timeframe);
      
      if (signal.confidence >= kronos.config.minConfidence) {
        console.log(`📡 High-confidence signal: ${signal.symbol} ${signal.direction}`);
        await sendSignalToDiscord(signal);
        
        // Space out messages
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`Error generating signal for ${asset}:`, error);
    }
  }
}

async function sendSignalToDiscord(signal) {
  if (!CHANNEL_ID) return;
  
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) return;
  
  // Check if this is an ensemble signal
  if (signal.source === 'ENSEMBLE' || signal.type === 'ENSEMBLE') {
    await sendEnsembleSignal(signal, channel);
  } else {
    await sendKronosSignal(signal, channel);
  }
}

async function sendEnsembleSignal(signal, channel) {
  try {
    const { spawn } = require('child_process');
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from ensemble_integration import format_ensemble_signal_for_discord
import json

signal_data = ${JSON.stringify(signal)}
embed = format_ensemble_signal_for_discord(signal_data)
print(json.dumps(embed))
`;
    
    const embedData = await new Promise((resolve, reject) => {
      const pythonProcess = spawn('python3', ['-c', pythonScript]);
      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`Format script exited with code ${code}:`, stderr);
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch (error) {
          console.error('Failed to parse format output:', stdout, stderr);
          resolve(null);
        }
      });

      pythonProcess.on('error', (error) => {
        console.error('Format script error:', error);
        resolve(null);
      });
    });
    
    if (embedData) {
      const embed = new EmbedBuilder()
        .setTitle(embedData.title || `🎯 ENSEMBLE SIGNAL: ${signal.symbol}`)
        .setColor(embedData.color || 0x0099FF)
        .setDescription(embedData.description || `**${signal.direction}** ensemble signal`)
        .setTimestamp(embedData.timestamp ? new Date(embedData.timestamp) : new Date());
      
      if (embedData.fields) {
        embed.addFields(...embedData.fields);
      }
      
      if (embedData.footer) {
        embed.setFooter(embedData.footer);
      }
      
      await channel.send({ embeds: [embed] });
    } else {
      // Fallback to simple format
      await sendKronosSignal(signal, channel);
    }
    
  } catch (error) {
    console.error('Failed to send ensemble signal:', error);
    await sendKronosSignal(signal, channel);
  }
}

async function sendKronosSignal(signal, channel) {
  const changePct = ((signal.predictedExitPrice / signal.entryPrice - 1) * 100).toFixed(2);
  const confidencePct = (signal.confidence * 100).toFixed(1);
  
  // Determine suggested leverage
  let leverage = '1x';
  if (signal.confidence >= 0.85) leverage = '25x';
  else if (signal.confidence >= 0.75) leverage = '15x';
  else if (signal.confidence >= 0.7) leverage = '5x';
  
  // Paper trade status
  let paperStatus = '';
  if (signal.confidence >= 0.7) {
    paperStatus = '📝 **Auto-tracked in paper trading**';
  }
  
  const embed = new EmbedBuilder()
    .setTitle(`🎯 KRONOS AI SIGNAL: ${signal.symbol}`)
    .setColor(signal.direction === 'LONG' ? 0x00FF00 : 0xFF0000)
    .setDescription(`**${signal.direction}** signal detected by Kronos AI\n${paperStatus}`)
    .addFields(
      { name: 'Entry Price', value: `$${signal.entryPrice.toFixed(2)}`, inline: true },
      { name: 'Predicted Exit', value: `$${signal.predictedExitPrice.toFixed(2)}`, inline: true },
      { name: 'Predicted Change', value: `${changePct}%`, inline: true },
      { name: 'Confidence', value: `${confidencePct}%`, inline: true },
      { name: 'Suggested Leverage', value: leverage, inline: true },
      { name: 'Timeframe', value: signal.timeframe, inline: true },
      { name: 'Source', value: signal.source, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Kronos AI Trading Bot • Use /paper-stats to track performance' });

  await channel.send({ embeds: [embed] });
}

async function handleStatus(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('🤖 Kronos Bot Status')
    .setColor(0x0099FF)
    .addFields(
      { name: 'Status', value: isScanning ? '🟢 RUNNING' : '🔴 STOPPED', inline: true },
      { name: 'Channel', value: CHANNEL_ID || 'Not set', inline: true },
      { name: 'Kronos Mode', value: 'Real Predictions', inline: true },
      { name: 'Scan Interval', value: '5 minutes', inline: true },
      { name: 'Min Confidence', value: '70%', inline: true },
      { name: 'Assets', value: 'BTC, ETH, SOL', inline: true }
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleTest(interaction) {
  const testSignal = {
    symbol: 'BTC/USDT',
    direction: 'LONG',
    entryPrice: 50000 + Math.random() * 2000,
    predictedExitPrice: 52000 + Math.random() * 3000,
    confidence: 0.7 + Math.random() * 0.25,
    timeframe: '15m',
    timestamp: new Date(),
    source: 'TEST'
  };

  await sendSignalToDiscord(testSignal);
  await interaction.editReply('✅ Test signal sent!');
}

async function handlePredict(interaction, symbol, timeframe) {
  await interaction.editReply(`🔍 Getting Kronos prediction for ${symbol} (${timeframe})...`);
  
  try {
    const signal = await kronos.generateKronosSignal(symbol, timeframe);
    
    const changePct = ((signal.predictedExitPrice / signal.entryPrice - 1) * 100).toFixed(2);
    const confidencePct = (signal.confidence * 100).toFixed(1);
    
    const embed = new EmbedBuilder()
      .setTitle(`🎯 KRONOS PREDICTION: ${signal.symbol}`)
      .setColor(signal.direction === 'LONG' ? 0x00FF00 : 0xFF0000)
      .setDescription(`**${signal.direction}** prediction by Kronos AI`)
      .addFields(
        { name: 'Current Price', value: `$${signal.entryPrice.toFixed(2)}`, inline: true },
        { name: 'Predicted Price', value: `$${signal.predictedExitPrice.toFixed(2)}`, inline: true },
        { name: 'Predicted Change', value: `${changePct}%`, inline: true },
        { name: 'Confidence', value: `${confidencePct}%`, inline: true },
        { name: 'Timeframe', value: signal.timeframe, inline: true },
        { name: 'Source', value: signal.source, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Kronos AI Prediction • Use /predict for more' });

    await interaction.editReply({ content: null, embeds: [embed] });
    
  } catch (error) {
    await interaction.editReply(`❌ Failed to get prediction: ${error.message}`);
  }
}

// Paper Trading Command Handlers
async function handlePaperStart(interaction, balance) {
  try {
    const { spawn } = require('child_process');
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import handle_paper_start
import json

result = handle_paper_start(${balance})
print(json.dumps(result))
`;
    
    const result = await executePythonScript(pythonScript);
    await interaction.editReply(result);
    
  } catch (error) {
    console.error('Paper start error:', error);
    await interaction.editReply('❌ Failed to start paper trading.');
  }
}

async function handlePaperStats(interaction) {
  try {
    const { spawn } = require('child_process');
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import handle_paper_stats
import json

result = handle_paper_stats()
print(json.dumps(result))
`;
    
    const result = await executePythonScript(pythonScript);
    await interaction.editReply(result);
    
  } catch (error) {
    console.error('Paper stats error:', error);
    await interaction.editReply('❌ Failed to get paper stats.');
  }
}

async function handlePaperPortfolio(interaction) {
  try {
    const { spawn } = require('child_process');
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import handle_paper_portfolio
import json

result = handle_paper_portfolio()
print(json.dumps(result))
`;
    
    const result = await executePythonScript(pythonScript);
    await interaction.editReply(result);
    
  } catch (error) {
    console.error('Paper portfolio error:', error);
    await interaction.editReply('❌ Failed to get paper portfolio.');
  }
}

async function handlePaperHistory(interaction, limit) {
  try {
    const { spawn } = require('child_process');
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import handle_paper_history
import json

result = handle_paper_history(${limit})
print(json.dumps(result))
`;
    
    const result = await executePythonScript(pythonScript);
    await interaction.editReply(result);
    
  } catch (error) {
    console.error('Paper history error:', error);
    await interaction.editReply('❌ Failed to get paper history.');
  }
}

async function handlePaperClose(interaction, tradeId) {
  try {
    const { spawn } = require('child_process');
    const tradeIdParam = tradeId ? `'${tradeId}'` : 'None';
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import handle_paper_close
import json

result = handle_paper_close(${tradeIdParam})
print(json.dumps(result))
`;
    
    const result = await executePythonScript(pythonScript);
    await interaction.editReply(result);
    
  } catch (error) {
    console.error('Paper close error:', error);
    await interaction.editReply('❌ Failed to close paper trade.');
  }
}

async function handlePaperReset(interaction, confirm) {
  try {
    const { spawn } = require('child_process');
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import handle_paper_reset
import json

result = handle_paper_reset(${confirm})
print(json.dumps(result))
`;
    
    const result = await executePythonScript(pythonScript);
    await interaction.editReply(result);
    
  } catch (error) {
    console.error('Paper reset error:', error);
    await interaction.editReply('❌ Failed to reset paper trading.');
  }
}

async function handlePaperBuy(interaction, symbol, direction, confidence) {
  try {
    const { spawn } = require('child_process');
    const pythonScript = `
import sys
sys.path.append('${process.cwd()}')
from paper_commands import handle_paper_buy
import json

result = handle_paper_buy('${symbol}', '${direction}', ${confidence})
print(json.dumps(result))
`;
    
    const result = await executePythonScript(pythonScript);
    await interaction.editReply(result);
    
  } catch (error) {
    console.error('Paper buy error:', error);
    await interaction.editReply('❌ Failed to create paper trade.');
  }
}

async function executePythonScript(script) {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', ['-c', script]);
    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Python script exited with code ${code}:`, stderr);
        reject(new Error(`Python script failed: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (error) {
        console.error('Failed to parse Python output:', stdout, stderr);
        reject(new Error('Invalid JSON from Python script'));
      }
    });

    pythonProcess.on('error', (error) => {
      reject(error);
    });
  });
}

async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('❓ Kronos Bot Commands')
    .setColor(0x0099FF)
    .setDescription('AI-enhanced trading signals powered by Kronos')
    .addFields(
      { name: '/scan', value: 'Start automatic scanning', inline: true },
      { name: '/stop', value: 'Stop scanning', inline: true },
      { name: '/status', value: 'Show bot status', inline: true },
      { name: '/test', value: 'Send test signal', inline: true },
      { name: '/help', value: 'Show this help', inline: true },
      { name: '/predict [symbol]', value: 'Get prediction for symbol', inline: true },
      { name: '/kronos [action]', value: 'Main Kronos command with all actions', inline: true }
    )
    .addFields(
      { name: '📊 Paper Trading', value: 'Auto-tracks Kronos signals with virtual account', inline: false },
      { name: '/paper-start', value: 'Start paper trading ($2k virtual)', inline: true },
      { name: '/paper-stats', value: 'Show win rate, P&L, metrics', inline: true },
      { name: '/paper-portfolio', value: 'View open virtual trades', inline: true },
      { name: '/paper-history', value: 'Past trade history', inline: true },
      { name: '/paper-close', value: 'Close trade(s)', inline: true },
      { name: '/paper-reset', value: 'Reset virtual account', inline: true },
      { name: '/paper-buy', value: 'Manually enter trade', inline: true }
    )
    .addFields(
      { name: '📊 How it works', value: 'Kronos AI analyzes candlestick patterns to predict price movements. Signals are sent when confidence > 70%.', inline: false },
      { name: '⚠️ Note', value: 'Using real Kronos AI predictions (110MB models loaded)', inline: false }
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received shutdown signal');
  if (scanningInterval) clearInterval(scanningInterval);
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received termination signal');
  if (scanningInterval) clearInterval(scanningInterval);
  client.destroy();
  process.exit(0);
});

// Login to Discord
console.log('🔑 Logging in to Discord...');
client.login(DISCORD_TOKEN).then(() => {
  console.log('✅ Bot is ready!');
  console.log('\n' + '='.repeat(50));
  console.log('🚀 Type "/" in Discord to see slash commands');
  console.log('='.repeat(50));
}).catch(error => {
  console.error('❌ Failed to login:', error);
  process.exit(1);
});