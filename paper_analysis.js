#!/usr/bin/env node

/**
 * Paper Trading Analysis Script for Discord Bot
 * 
 * This script fetches messages from a Discord paper-trading channel,
 * parses trade entries/exits, and computes performance metrics.
 * 
 * Usage:
 *   node paper_analysis.js [--config path/to/config.json] [--output path/to/report.md]
 * 
 * Configuration: see paper_analysis_config.json
 */

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

// ----- Configuration -----
let configPath = path.join(__dirname, 'paper_analysis_config.json');
let outputPath = null;

// Parse CLI arguments
process.argv.slice(2).forEach((arg, i) => {
  if (arg === '--config' && process.argv[i + 3]) {
    configPath = process.argv[i + 3];
  } else if (arg === '--output' && process.argv[i + 3]) {
    outputPath = process.argv[i + 3];
  }
});

if (!fs.existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { token, channelId, guildId, paperChannelName } = config.discord;
const { maxMessages, timeRangeDays, outputFile } = config.analysis;
if (outputPath) outputPath = outputPath;

// ----- Discord Client -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    let channel;
    if (channelId) {
      channel = await client.channels.fetch(channelId);
    } else if (guildId && paperChannelName) {
      const guild = await client.guilds.fetch(guildId);
      const channels = await guild.channels.fetch();
      channel = channels.find(
        c => c.name === paperChannelName && c.type === 0 // GUILD_TEXT
      );
      if (!channel) {
        throw new Error(`Channel "${paperChannelName}" not found in guild ${guildId}`);
      }
    } else {
      throw new Error('Either channelId or guildId+paperChannelName must be provided');
    }

    console.log(`Fetching messages from #${channel.name}...`);
    const messages = [];
    let lastId = null;
    let fetched;
    do {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      fetched = await channel.messages.fetch(options);
      if (fetched.size > 0) {
        lastId = fetched.lastKey();
        messages.push(...fetched.values());
      }
    } while (fetched.size > 0 && messages.length < maxMessages);

    console.log(`Fetched ${messages.length} messages.`);

    // Parse trade data from messages
    const trades = parseTrades(messages);
    const analysis = analyzeTrades(trades);

    // Generate report
    const report = generateReport(analysis, trades);
    console.log(report);

    // Save to file
    const outputPathFinal = outputPath || outputFile || 'paper_trading_analysis.md';
    fs.writeFileSync(outputPathFinal, report);
    console.log(`Report saved to ${outputPathFinal}`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.destroy();
  }
});

client.login(token).catch(err => {
  console.error('Failed to log in:', err.message);
  process.exit(1);
});

// ----- Parsing -----
function parseTrades(messages) {
  const trades = [];
  
  for (const msg of messages) {
    const embed = msg.embeds && msg.embeds[0];
    if (!embed) continue;
    
    const title = embed.title || '';
    const description = embed.description || '';
    
    // Parse closed trades (with P&L)
    if (title.includes('Paper Trade Closed')) {
      const trade = {};
      // Extract asset from title: "📄 Paper Trade Closed: DOGE LOSS ❌"
      const assetMatch = title.match(/Paper Trade Closed: ([A-Z0-9]+) /);
      if (assetMatch) trade.asset = assetMatch[1];
      
      // Determine win/loss from title
      trade.direction = title.includes('LONG') ? 'LONG' : title.includes('SHORT') ? 'SHORT' : '';
      
      // Parse description lines
      const lines = description.split('\n');
      lines.forEach(line => {
        const entryMatch = line.match(/\*\*Entry:\*\*\s*\$([\d.]+)\s*→\s*\*\*Exit:\*\*\s*\$([\d.]+)/);
        if (entryMatch) {
          trade.entryPrice = parseFloat(entryMatch[1]);
          trade.exitPrice = parseFloat(entryMatch[2]);
        }
        const pnlMatch = line.match(/\*\*P&L:\*\*\s*\$([+-]?[\d.]+)\s*\(([-+]?[\d.]+)R\)/);
        if (pnlMatch) {
          trade.pnlDollar = parseFloat(pnlMatch[1]);
          trade.pnlR = parseFloat(pnlMatch[2]);
        }
        const reasonMatch = line.match(/\*\*Reason:\*\*\s*([^|]+)/);
        if (reasonMatch) trade.closeReason = reasonMatch[1].trim();
        const holdMatch = line.match(/\*\*Hold:\*\*\s*(\d+)min/);
        if (holdMatch) trade.duration = parseInt(holdMatch[1]);
        const balanceMatch = line.match(/\*\*Balance:\*\*\s*\$([\d.]+)/);
        if (balanceMatch) trade.balanceAfter = parseFloat(balanceMatch[1]);
      });
      
      if (trade.asset && trade.entryPrice !== undefined) {
        trades.push(trade);
      }
    }
    
    // Parse filled/entered trades (no P&L yet)
    else if (title.includes('Paper Trade Filled') || title.includes('Paper Trade Entered')) {
      const trade = {};
      // Extract asset and direction from title: "✅ Paper Trade Filled: 🔴 SHORT DOGE"
      const directionMatch = title.match(/(LONG|SHORT) ([A-Z0-9]+)/);
      if (directionMatch) {
        trade.direction = directionMatch[1];
        trade.asset = directionMatch[2];
      }
      
      // Parse description lines
      const lines = description.split('\n');
      lines.forEach(line => {
        const entryMatch = line.match(/\*\*@\s*\$([\d.]+)\*\*/);
        if (entryMatch) trade.entryPrice = parseFloat(entryMatch[1]);
        const slMatch = line.match(/SL:\s*\$([\d.]+)/);
        if (slMatch) trade.stopLoss = parseFloat(slMatch[1]);
        const tpMatch = line.match(/TP:\s*\$([\d.]+)/);
        if (tpMatch) trade.takeProfit = parseFloat(tpMatch[1]);
        const balanceMatch = line.match(/Balance remaining:\s*\$([\d.]+)/);
        if (balanceMatch) trade.balanceRemaining = parseFloat(balanceMatch[1]);
      });
      
      // These trades are not closed, so skip for performance analysis
      // But we could keep them for open positions tracking
      // For now, skip.
    }
    
    // Parse midday check-in (contains summary stats)
    else if (title.includes('Paper Trading Midday Check-in')) {
      // Could extract summary stats if needed
    }
  }
  
  console.log(`Parsed ${trades.length} closed trades.`);
  return trades;
}

// ----- Analysis -----
function analyzeTrades(trades) {
  if (trades.length === 0) {
    return { error: 'No trades found' };
  }
  
  const wins = trades.filter(t => (t.pnlDollar || 0) > 0);
  const losses = trades.filter(t => (t.pnlDollar || 0) <= 0);
  const winRate = wins.length / trades.length;
  
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnlDollar || 0), 0);
  const avgR = trades.reduce((sum, t) => sum + (t.pnlR || 0), 0) / trades.length;
  
  // Equity curve simulation (starting with $1000)
  let equity = 1000;
  let peak = equity;
  let maxDrawdown = 0;
  trades.forEach(t => {
    equity += t.pnlDollar || 0;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  });
  
  return {
    totalTrades: trades.length,
    winRate: winRate * 100,
    avgR,
    totalPnl,
    finalEquity: equity,
    maxDrawdown: maxDrawdown * 100,
    wins: wins.length,
    losses: losses.length,
  };
}

// ----- Report Generation -----
function generateReport(analysis, trades) {
  if (analysis.error) {
    return `# Paper Trading Analysis\n\nError: ${analysis.error}\n`;
  }
  
  let report = `# Paper Trading Analysis\n\n`;
  report += `**Generated:** ${new Date().toLocaleString()}\n`;
  report += `**Total Trades:** ${analysis.totalTrades}\n`;
  report += `**Win Rate:** ${analysis.winRate.toFixed(2)}% (${analysis.wins}W/${analysis.losses}L)\n`;
  report += `**Average R:** ${analysis.avgR.toFixed(2)}R\n`;
  report += `**Total P&L:** $${analysis.totalPnl.toFixed(2)}\n`;
  report += `**Final Equity:** $${analysis.finalEquity.toFixed(2)}\n`;
  report += `**Max Drawdown:** ${analysis.maxDrawdown.toFixed(2)}%\n\n`;
  
  report += `## Trade Details\n\n`;
  report += `| Asset | Direction | Entry | P&L ($) | R |\n`;
  report += `|-------|-----------|-------|--------|---|\n`;
  trades.forEach(t => {
    const pnl = t.pnlDollar || 0;
    const r = t.pnlR || 0;
    report += `| ${t.asset || '?'} | ${t.direction || '?'} | ${t.entryPrice || '?'} | ${pnl.toFixed(2)} | ${r.toFixed(2)} |\n`;
  });
  
  report += `\n## Recommendations\n\n`;
  if (analysis.winRate < 40) {
    report += `- **Win rate is low (${analysis.winRate.toFixed(2)}%).** Consider tightening entry criteria or improving strategy filters.\n`;
  }
  if (analysis.maxDrawdown > 20) {
    report += `- **Max drawdown is high (${analysis.maxDrawdown.toFixed(2)}%).** Review risk management (position sizing, stop losses).\n`;
  }
  if (analysis.avgR < 1) {
    report += `- **Average R is low (${analysis.avgR.toFixed(2)}).** Aim for at least 1.5R per trade.\n`;
  }
  
  return report;
}