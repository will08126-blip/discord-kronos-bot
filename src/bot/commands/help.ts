import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('How to use this bot — getting started guide and command reference');

const LINE = '━━━━━━━━━━━━━━━━━━━━━━━';

const COMMAND_SECTIONS = [
  {
    title: '📈 Active Trading',
    commands: [
      {
        name: '/positions',
        desc: 'See all open trades with entry, stop loss, take profit, and leverage. Each position has a 🔴 **Close** button — click it to close the trade instantly.',
      },
      {
        name: '/close <price> [id]',
        desc: 'Fallback command if buttons are unavailable. Provide the exit price; leave the ID blank if only one trade is open.',
      },
      {
        name: '/trade-status [id]',
        desc: 'Live letter grade (S / A+ / A / B / C / D / F) for your open trade(s) based on R-multiple, progress to TP, RSI momentum, and time in trade. Omit the ID to grade all open positions.',
      },
      {
        name: '/pulse',
        desc: 'Force an immediate health check on all open positions right now — no need to wait for the automatic cycle.',
      },
    ],
  },
  {
    title: '🔍 Market Analysis',
    commands: [
      {
        name: '/scan',
        desc: 'Force a market scan right now instead of waiting for the next scheduled cycle.',
      },
      {
        name: '/check <symbol>',
        desc: 'Deep analysis of any symbol (e.g. BTC, SOL, DOGE). Shows all strategy results including setups below the score threshold.',
      },
      {
        name: '/live <start|stop>',
        desc: 'Auto-updating watchlist for the top Coinbase coins — refreshes every 5 minutes. Use `/live stop` to dismiss.',
      },
    ],
  },
  {
    title: '📊 Performance & Stats',
    commands: [
      {
        name: '/status',
        desc: 'Bot health dashboard: market regimes, pending signals, open positions, daily P&L, and strategy weights.',
      },
      {
        name: '/history [count]',
        desc: 'Last N closed trades (default 5, max 20) with asset, direction, strategy, R-multiple P&L, and exit reason.',
      },
      {
        name: '/performance [period]',
        desc: 'Full stats: win rate, profit factor, avg score, per-strategy breakdown. Periods: today / week / all.',
      },
      {
        name: '/report <daily|weekly>',
        desc: 'AI-powered performance summary for today or the past 7 days (requires ANTHROPIC_API_KEY).',
      },
    ],
  },
  {
    title: '📄 Paper Trading  ·  check #paper-trading',
    commands: [
      {
        name: '/paper-status',
        desc: 'Virtual account overview: current balance, all-time P&L, win rate, profit factor, and current streak.',
      },
      {
        name: '/paper-positions',
        desc: 'All currently open paper trades with entry, SL, TP, leverage, and unrealised P&L.',
      },
      {
        name: '/paper-history [count]',
        desc: 'Last N closed paper trades (default 10). Shows entry → exit, P&L in $ and R-multiple, hold time, and close reason.',
      },
      {
        name: '/paper-performance [period]',
        desc: 'Full paper trading stats breakdown. Periods: daily / weekly / all. Includes win rate, profit factor, best/worst trade, and per-strategy results.',
      },
      {
        name: '/daily-report [date]',
        desc: 'Generate today\'s paper trading report as a Markdown file. Paste it into Claude to get improvement suggestions. Optional: pass a date override (YYYY-MM-DD).',
      },
      {
        name: '/paper-reset',
        desc: 'Wipe all paper trade history and restore the virtual balance to $1,000. Useful when starting a new testing cycle or after major strategy changes.',
      },
    ],
  },
  {
    title: '⚙️ Settings',
    commands: [
      {
        name: '/toggle <on|off>',
        desc: 'Enable or disable signal scanning. When off, no new signals are posted until you re-enable.',
      },
      {
        name: '/filter <strict|normal|relaxed>',
        desc: 'Adjust the signal quality threshold. **strict** = score ≥ 75 (ELITE only). **normal** = score ≥ 60 (default). **relaxed** = score ≥ 45 (most signals).',
      },
      {
        name: '/weights <view|reset|set>',
        desc: 'Manage per-strategy signal weights. **view** — current weights. **reset** — restore defaults. **set strategy:<name> value:<0.5–1.0>** — pin a weight manually.',
      },
      {
        name: '/config',
        desc: 'View current bot config: scan interval, max positions, daily loss limit, score threshold, leverage caps, and monitored assets.',
      },
    ],
  },
];

export async function execute(interaction: ChatInputCommandInteraction) {
  const gettingStarted = new EmbedBuilder()
    .setColor(0x00ff87)
    .setTitle('🚀 Getting Started — How It Works')
    .setDescription('Two dedicated channels, two jobs. Here\'s the full picture:')
    .addFields(
      {
        name: '📡  #bot-signals — Your Trading Signals',
        value: [
          '**1️⃣  Bot scans** the top Coinbase coins every 5 minutes (+ Gold, Silver, QQQ, SPY)',
          '**2️⃣  Signal posted** — entry zone, stop loss, take profit, leverage, and score',
          '**3️⃣  You enter** — if you take the trade on your exchange, click ✅ **Entered**',
          '**4️⃣  Bot monitors** — alerts you if price approaches SL or TP, trails your stop',
          '**5️⃣  You exit** — click 🔴 **Close Position** on the tracking message',
          '**6️⃣  Bot records** — calculates P&L, R-multiple, and updates your performance stats',
          '',
          '_Strategies: Scalp FVG+MACD (50–80x), Swing, Trend Pullback, Breakout, Volatility_',
        ].join('\n'),
        inline: false,
      },
      {
        name: `${LINE}`,
        value: ' ',
        inline: false,
      },
      {
        name: '📄  #paper-trading — Automated Bot Activity',
        value: [
          'The bot auto-trades every signal in a virtual $1,000 account — no action needed from you.',
          '',
          '• Every signal entry and exit is posted automatically with full P&L',
          '• **12:00 UTC** — midday heartbeat: balance, open positions, today\'s W/L/P&L',
          '• **00:00 UTC** — full daily report: all closed trades, best/worst, strategy breakdown',
          '• **Sunday 00:00 UTC** — weekly self-improvement report: the bot analyses its own',
          '  win rate by asset, hour, regime, and indicator, then auto-adjusts its parameters',
          '',
          '_Use the `/paper-*` commands to query the paper account anytime_',
        ].join('\n'),
        inline: false,
      },
      {
        name: '💡 Tips',
        value: [
          '• **R-multiples** = how many times your risk you made/lost (+2R = made 2× your stop distance)',
          '• **Score tiers** — ELITE (≥80), STRONG (≥60), MEDIUM (≥40); higher = more conviction',
          '• **Scalp signals** fire most frequently at 50–80x leverage with tight FVG-based stops',
          '• Signals expire after 2 hours if not confirmed via ✅ Entered',
          '• The `/status` command shows bot health, regime, and which strategies are active',
        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({ text: 'Use /help anytime · Paper trading never risks real money' });

  const commandRef = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📖 Command Reference');

  for (const section of COMMAND_SECTIONS) {
    commandRef.addFields({
      name: section.title,
      value: section.commands.map((c) => `**${c.name}**\n${c.desc}`).join('\n\n'),
      inline: false,
    });
  }

  await interaction.reply({ embeds: [gettingStarted, commandRef], ephemeral: true });
}
