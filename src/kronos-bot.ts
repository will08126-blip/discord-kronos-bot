/**
 * Kronos Discord Bot - AI-Enhanced Trading Signals
 * 
 * This is a NEW Discord bot dedicated to Kronos AI signals.
 * Separate from your existing working bot.
 */

import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js';
import { KronosValidator } from './kronos';
import type { StrategySignal, Asset, Timeframe } from './types';

export class KronosDiscordBot {
  private client: Client;
  private kronos: KronosValidator;
  private channelId: string = '';
  private isRunning: boolean = false;

  constructor() {
    // Create Discord client with minimal intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    // Initialize Kronos
    this.kronos = new KronosValidator({
      enabled: true,
      weight: 0.3,
      minConfidence: 0.6
    });

    this.setupEventHandlers();
  }

  /**
   * Setup Discord event handlers
   */
  private setupEventHandlers(): void {
    this.client.on('ready', () => {
      console.log(`✅ Kronos Discord Bot logged in as ${this.client.user?.tag}`);
      console.log(`📊 Monitoring channel: ${this.channelId || 'Not set'}`);
    });

    this.client.on('messageCreate', async (message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      // Simple commands
      if (message.content.startsWith('!kronos')) {
        await this.handleCommand(message);
      }
    });
  }

  /**
   * Handle bot commands
   */
  private async handleCommand(message: any): Promise<void> {
    const args = message.content.split(' ');
    const command = args[1]?.toLowerCase();

    switch (command) {
      case 'start':
        await this.startScanning(message);
        break;
      
      case 'stop':
        this.stopScanning();
        await message.reply('🛑 Kronos scanning stopped');
        break;
      
      case 'status':
        await this.sendStatus(message.channel);
        break;
      
      case 'test':
        await this.sendTestSignal(message.channel);
        break;
      
      case 'help':
        await this.sendHelp(message.channel);
        break;
      
      default:
        await message.reply('Unknown command. Use `!kronos help`');
    }
  }

  /**
   * Start automatic scanning
   */
  private async startScanning(message: any): Promise<void> {
    if (this.isRunning) {
      await message.reply('⚠️ Kronos is already scanning');
      return;
    }

    // Set channel for signals
    this.channelId = message.channel.id;
    
    await message.reply('🚀 Starting Kronos AI scanning...');
    
    // Initialize Kronos
    const initialized = await this.kronos.initialize();
    if (!initialized) {
      await message.reply('❌ Failed to initialize Kronos. Running in mock mode.');
    }

    this.isRunning = true;
    
    // Start scanning loop
    this.scanLoop();
  }

  /**
   * Stop scanning
   */
  private stopScanning(): void {
    this.isRunning = false;
  }

  /**
   * Main scanning loop
   */
  private async scanLoop(): Promise<void> {
    console.log('🔍 Kronos scanning loop started');
    
    while (this.isRunning) {
      try {
        await this.scanCycle();
        
        // Wait before next scan (e.g., 5 minutes)
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
      } catch (error) {
        console.error('Scan cycle error:', error);
        await new Promise(resolve => setTimeout(resolve, 60 * 1000));
      }
    }
    
    console.log('🛑 Kronos scanning stopped');
  }

  /**
   * Single scan cycle
   */
  private async scanCycle(): Promise<void> {
    if (!this.channelId) return;

    const channel = await this.client.channels.fetch(this.channelId) as TextChannel;
    if (!channel) return;

    console.log(`📊 Running Kronos scan cycle at ${new Date().toISOString()}`);

    // Assets to scan
    const assets: Asset[] = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    const timeframe: Timeframe = '15m';

    // Generate Kronos signals
    const signals = await this.generateKronosSignals(assets, timeframe);
    
    // Filter for high confidence
    const highConfidence = signals.filter(s => s.confidence >= 0.7);
    
    if (highConfidence.length > 0) {
      console.log(`📡 Found ${highConfidence.length} high-confidence signals`);
      
      // Send each signal to Discord
      for (const signal of highConfidence) {
        await this.sendSignalEmbed(channel, signal);
        
        // Space out messages
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } else {
      console.log('📭 No high-confidence signals found');
    }
  }

  /**
   * Generate Kronos signals for assets
   */
  private async generateKronosSignals(assets: Asset[], timeframe: Timeframe): Promise<any[]> {
    const signals: any[] = [];
    
    for (const asset of assets) {
      try {
        const signal = await this.kronos.generateKronosSignal(asset, timeframe);
        if (signal && signal.confidence >= this.kronos['config'].minConfidence) {
          signals.push(signal);
        }
      } catch (error) {
        console.error(`Failed to generate signal for ${asset}:`, error);
      }
    }
    
    return signals;
  }

  /**
   * Send signal as Discord embed
   */
  private async sendSignalEmbed(channel: TextChannel, signal: any): Promise<void> {
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

  /**
   * Send test signal
   */
  private async sendTestSignal(channel: any): Promise<void> {
    const testSignal = {
      symbol: 'BTC/USDT',
      direction: 'LONG',
      entryPrice: 50000 + Math.random() * 2000,
      predictedExitPrice: 52000 + Math.random() * 3000,
      confidence: 0.7 + Math.random() * 0.25,
      timeframe: '15m',
      timestamp: new Date()
    };

    await this.sendSignalEmbed(channel, testSignal);
  }

  /**
   * Send bot status
   */
  private async sendStatus(channel: any): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('🤖 Kronos Bot Status')
      .setColor(0x0099FF)
      .addFields(
        { name: 'Status', value: this.isRunning ? '🟢 RUNNING' : '🔴 STOPPED', inline: true },
        { name: 'Channel', value: this.channelId || 'Not set', inline: true },
        { name: 'Kronos Mode', value: 'Mock Predictions', inline: true },
        { name: 'Scan Interval', value: '5 minutes', inline: true },
        { name: 'Min Confidence', value: '70%', inline: true },
        { name: 'Assets', value: 'BTC, ETH, SOL', inline: true }
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  /**
   * Send help message
   */
  private async sendHelp(channel: any): Promise<void> {
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

  /**
   * Login to Discord
   */
  async login(token: string): Promise<void> {
    await this.client.login(token);
    console.log('🔑 Logging in to Discord...');
  }

  /**
   * Shutdown bot
   */
  async shutdown(): Promise<void> {
    this.stopScanning();
    this.client.destroy();
    console.log('👋 Kronos bot shutdown');
  }
}