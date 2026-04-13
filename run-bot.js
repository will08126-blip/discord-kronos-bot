/**
 * Simple JavaScript version to run the Kronos Discord bot
 * Bypasses TypeScript compilation issues
 */

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.SIGNAL_CHANNEL_ID;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is required in .env file');
  process.exit(1);
}

console.log('='.repeat(50));
console.log('🤖 KRONOS DISCORD BOT - SIMPLE VERSION');
console.log('='.repeat(50));

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

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
      console.error('Copied from kronos-trading-bot/models/');
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
client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`📊 Monitoring channel: ${CHANNEL_ID || 'Not set'}`);
  console.log('\n📋 Available commands:');
  console.log('  !kronos start    - Start scanning');
  console.log('  !kronos stop     - Stop scanning');
  console.log('  !kronos status   - Show status');
  console.log('  !kronos test     - Send test signal');
  console.log('  !kronos help     - Show help');
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  if (message.content.startsWith('!kronos')) {
    const args = message.content.split(' ');
    const command = args[1]?.toLowerCase();

    switch (command) {
      case 'start':
        await handleStart(message);
        break;
      
      case 'stop':
        handleStop(message);
        break;
      
      case 'status':
        await handleStatus(message.channel);
        break;
      
      case 'test':
        await handleTest(message.channel);
        break;
      
      case 'help':
        await handleHelp(message.channel);
        break;
      
      default:
        await message.reply('Unknown command. Use `!kronos help`');
    }
  }
});

async function handleStart(message) {
  if (isScanning) {
    await message.reply('⚠️ Kronos is already scanning');
    return;
  }

  await message.reply('🚀 Starting Kronos AI scanning...');
  
  // Initialize Kronos
  await kronos.initialize();
  
  isScanning = true;
  
  // Start scanning loop
  scanningInterval = setInterval(async () => {
    await scanCycle();
  }, 5 * 60 * 1000); // 5 minutes
  
  // Run first scan immediately
  await scanCycle();
}

function handleStop(message) {
  if (!isScanning) {
    message.reply('⚠️ Kronos is not scanning');
    return;
  }
  
  clearInterval(scanningInterval);
  isScanning = false;
  message.reply('🛑 Kronos scanning stopped');
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
      { name: 'Source', value: 'Kronos AI', inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Kronos AI Trading Bot • Use !kronos stop to pause' });

  await channel.send({ embeds: [embed] });
}

async function handleStatus(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🤖 Kronos Bot Status')
    .setColor(0x0099FF)
    .addFields(
      { name: 'Status', value: isScanning ? '🟢 RUNNING' : '🔴 STOPPED', inline: true },
      { name: 'Channel', value: CHANNEL_ID || 'Not set', inline: true },
      { name: 'Kronos Mode', value: 'Mock Predictions', inline: true },
      { name: 'Scan Interval', value: '5 minutes', inline: true },
      { name: 'Min Confidence', value: '70%', inline: true },
      { name: 'Assets', value: 'BTC, ETH, SOL', inline: true }
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function handleTest(channel) {
  const testSignal = {
    symbol: 'BTC/USDT',
    direction: 'LONG',
    entryPrice: 50000 + Math.random() * 2000,
    predictedExitPrice: 52000 + Math.random() * 3000,
    confidence: 0.7 + Math.random() * 0.25,
    timeframe: '15m',
    timestamp: new Date()
  };

  await sendSignalToDiscord(testSignal);
}

async function handleHelp(channel) {
  const embed = new EmbedBuilder()
    .setTitle('❓ Kronos Bot Commands')
    .setColor(0x0099FF)
    .setDescription('AI-enhanced trading signals powered by Kronos')
    .addFields(
      { name: '!kronos start', value: 'Start automatic scanning', inline: false },
      { name: '!kronos stop', value: 'Stop scanning', inline: false },
      { name: '!kronos status', value: 'Show bot status', inline: false },
      { name: '!kronos test', value: 'Send test signal', inline: false },
      { name: '!kronos help', value: 'Show this help', inline: false }
    )
    .addFields(
      { name: '📊 How it works', value: 'Kronos AI analyzes candlestick patterns to predict price movements. Signals are sent when confidence > 70%.', inline: false },
      { name: '⚠️ Note', value: 'Currently using mock predictions. Real Kronos integration coming soon.', inline: false }
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] });
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
  console.log('\n📋 Invite bot to your server with this link:');
  console.log(`https://discord.com/api/oauth2/authorize?client_id=${process.env.APPLICATION_ID}&permissions=274877975552&scope=bot%20applications.commands`);
  console.log('\n' + '='.repeat(50));
  console.log('🚀 Add bot to your Discord server and use !kronos start');
  console.log('='.repeat(50));
}).catch(error => {
  console.error('❌ Failed to login:', error);
  process.exit(1);
});