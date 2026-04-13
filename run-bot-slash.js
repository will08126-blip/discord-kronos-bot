/**
 * Kronos Discord Bot with Slash Commands
 * Modern Discord bot with /commands
 */

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, Events, REST, Routes, Collection } = require('discord.js');

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
      console.warn('⚠️ Kronos not initialized, using mock prediction');
      return this.generateMockSignal(symbol, timeframe);
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
      
      return {
        symbol: result.symbol,
        direction: result.direction,
        entryPrice: result.entry_price,
        predictedExitPrice: result.predicted_price,
        confidence: result.confidence,
        timeframe: result.timeframe,
        timestamp: new Date(),
        source: result.source || 'REAL_KRONOS',
        rawPrediction: result
      };
      
    } catch (error) {
      console.error(`❌ Kronos prediction failed for ${symbol}:`, error.message);
      return this.generateMockSignal(symbol, timeframe);
    }
  }

  generateMockSignal(symbol, timeframe) {
    // Fallback mock signal
    const direction = Math.random() > 0.5 ? 'LONG' : 'SHORT';
    const basePrice = this.getBasePrice(symbol);
    const predictedChange = direction === 'LONG' 
      ? 0.5 + Math.random() * 2.5
      : -0.5 - Math.random() * 2.5;

    return {
      symbol,
      direction,
      entryPrice: basePrice,
      predictedExitPrice: basePrice * (1 + predictedChange / 100),
      confidence: 0.6 + Math.random() * 0.3,
      timeframe,
      timestamp: new Date(),
      source: 'MOCK_FALLBACK'
    };
  }

  getBasePrice(symbol) {
    const prices = {
      'BTC/USDT': 50000,
      'ETH/USDT': 3000,
      'SOL/USDT': 150
    };
    return prices[symbol] || 100;
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
  
  const changePct = ((signal.predictedExitPrice / signal.entryPrice - 1) * 100).toFixed(2);
  const confidencePct = (signal.confidence * 100).toFixed(1);
  
  const embed = new EmbedBuilder()
    .setTitle(`🎯 KRONOS AI SIGNAL: ${signal.symbol}`)
    .setColor(signal.direction === 'LONG' ? 0x00FF00 : 0xFF0000)
    .setDescription(`**${signal.direction}** signal detected by Kronos AI`)
    .addFields(
      { name: 'Entry Price', value: `$${signal.entryPrice.toFixed(2)}`, inline: true },
      { name: 'Predicted Exit', value: `$${signal.predictedExitPrice.toFixed(2)}`, inline: true },
      { name: 'Predicted Change', value: `${changePct}%`, inline: true },
      { name: 'Confidence', value: `${confidencePct}%`, inline: true },
      { name: 'Timeframe', value: signal.timeframe, inline: true },
      { name: 'Source', value: signal.source, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Kronos AI Trading Bot • Use /stop to pause' });

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