/**
 * Kronos Discord Bot - Main Entry Point
 * 
 * New Discord bot dedicated to Kronos AI trading signals.
 * Separate from your existing working bot.
 */

import { KronosDiscordBot } from './src/kronos-bot';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const CHANNEL_ID = process.env.SIGNAL_CHANNEL_ID || '';

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is required in .env file');
  console.error('Create a new Discord bot at: https://discord.com/developers/applications');
  process.exit(1);
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(50));
  console.log('🤖 KRONOS DISCORD BOT');
  console.log('AI-Enhanced Trading Signals');
  console.log('='.repeat(50));
  
  // Create bot instance
  const bot = new KronosDiscordBot();
  
  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received shutdown signal');
    await bot.shutdown();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received termination signal');
    await bot.shutdown();
    process.exit(0);
  });
  
  try {
    // Login to Discord
    console.log('🔑 Logging in to Discord...');
    await bot.login(DISCORD_TOKEN);
    
    console.log('\n✅ Bot is ready!');
    console.log('\n📋 Available commands in Discord:');
    console.log('  !kronos start    - Start automatic scanning');
    console.log('  !kronos stop     - Stop scanning');
    console.log('  !kronos status   - Show bot status');
    console.log('  !kronos test     - Send test signal');
    console.log('  !kronos help     - Show help');
    
    console.log('\n📊 Bot will scan: BTC/USDT, ETH/USDT, SOL/USDT');
    console.log('⏰ Scan interval: 5 minutes');
    console.log('🎯 Min confidence: 70%');
    console.log('💡 Mode: Mock predictions (safe testing)');
    
    console.log('\n' + '='.repeat(50));
    console.log('🚀 Add bot to your Discord server and use !kronos start');
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Run main function
main().catch(console.error);