import type { Client, TextChannel } from 'discord.js';
import { ChannelType, EmbedBuilder } from 'discord.js';
import { deployCommands, commands } from '../commands/index';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { CRYPTO_ASSETS } from '../../data/topCryptos';

export async function onReady(client: Client): Promise<void> {
  logger.info(`Discord bot ready — logged in as ${client.user?.tag}`);

  // ── Determine guild ID for command registration ────────────────────────────
  // Guild-scoped commands are available INSTANTLY; global commands take up to 1 hour.
  // Strategy:
  //   1. Use DISCORD_GUILD_ID env var if set (explicit, most reliable)
  //   2. Auto-detect from signal channel guildId
  //   3. Fallback: first guild in the bot's guild cache (works when bot is in 1 server)
  //   4. Last resort: global deployment (1h delay — avoid if possible)

  let guildId: string | undefined = process.env.DISCORD_GUILD_ID || undefined;

  if (!guildId) {
    try {
      const channel = await client.channels.fetch(config.discord.signalChannelId);
      if (channel && 'guildId' in channel && typeof (channel as any).guildId === 'string') {
        guildId = (channel as any).guildId as string;
        logger.info(`Auto-detected guild ID ${guildId} from signal channel — commands will be instant`);
      }
    } catch (err) {
      logger.warn('Could not auto-detect guild ID from signal channel:', err);
    }
  } else {
    logger.info(`DISCORD_GUILD_ID set — deploying guild-scoped commands (instant)`);
  }

  // Fallback: use first guild in cache (reliable when bot is in exactly one server)
  if (!guildId) {
    const firstGuild = client.guilds.cache.first();
    if (firstGuild) {
      guildId = firstGuild.id;
      logger.info(`Guild ID fallback — using first cached guild ${guildId}`);
    }
  }

  if (!guildId) {
    logger.warn('No guild ID found — falling back to global commands (up to 1h propagation)');
  }

  // ── Find or create dedicated bot channels ──────────────────────────────────
  // The bot self-manages two channels on every startup:
  //   #bot-signals    (BOT_CHANNEL_NAME)   — live trade signals & daily summary
  //   #paper-trading  (PAPER_CHANNEL_NAME) — paper trade entries, exits, reports
  // On first boot both are created; on subsequent boots they are reused.
  if (guildId) {
    const sigChannelName   = process.env.BOT_CHANNEL_NAME   ?? 'bot-signals';
    const paperChannelName = process.env.PAPER_CHANNEL_NAME ?? 'paper-trading';
    try {
      const guild      = await client.guilds.fetch(guildId);
      const allChannels = await guild.channels.fetch();

      /** Find a GuildText channel by name or create it if absent. */
      async function findOrCreate(name: string, topic: string): Promise<TextChannel> {
        const existing = allChannels.find(
          (c): c is TextChannel =>
            c !== null && c.type === ChannelType.GuildText && c.name === name
        ) as TextChannel | undefined;
        if (existing) {
          logger.info(`Channel setup: reusing #${name} (${existing.id})`);
          return existing;
        }
        const created = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          topic,
          reason: 'Discord Trading Bot — auto-created channel',
        });
        logger.info(`Channel setup: created #${name} (${created.id})`);
        return created;
      }

      // Create both channels concurrently (one guild fetch, two channel ops)
      const [sigChannel, paperChannel] = await Promise.all([
        findOrCreate(
          sigChannelName,
          '🤖 Live trading signals and daily market summaries — managed by bot'
        ),
        findOrCreate(
          paperChannelName,
          '📄 Paper trade entries, exits, P&L, and daily performance reports — managed by bot'
        ),
      ]);

      // Wire config — all runtime channel lookups use these IDs
      config.discord.signalChannelId  = sigChannel.id;
      config.discord.summaryChannelId = sigChannel.id;
      config.discord.paperChannelId   = paperChannel.id;

    } catch (err) {
      // Non-fatal — fall back to whatever is in env vars
      logger.warn(
        `Channel setup failed — check the bot has Manage Channels permission. ` +
        `Falling back to SIGNAL_CHANNEL_ID for all notifications. Error: ${err}`
      );
      // If paper channel is still unset use signal channel as fallback
      if (!config.discord.paperChannelId) {
        config.discord.paperChannelId = config.discord.signalChannelId;
      }
    }
  }

  // ── Deploy commands ────────────────────────────────────────────────────────
  let deployError: string | null = null;
  try {
    await deployCommands(guildId);
  } catch (err) {
    deployError = String(err);
    logger.error('Command deployment failed:', err);
  }

  // ── Post startup messages to both channels ─────────────────────────────────
  // #bot-signals  → command list + "manual trading" explanation
  // #paper-trading → "automated bot learning loop" explanation
  // Both messages post on every restart so the purpose of each channel is always clear.

  const commandList = [...commands.keys()]
    .map((name) => `\`/${name}\``)
    .join('  ');

  // --- #bot-signals ---
  try {
    const channel = await client.channels.fetch(config.discord.signalChannelId);
    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(deployError ? 0xff4444 : 0x00ff87)
        .setTitle(deployError ? '⚠️ Bot Online — Command Registration Failed' : '✅ #bot-signals — Live Trading Channel')
        .setDescription(
          deployError
            ? `Commands could not be registered: \`${deployError}\`\n\nSlash commands may not be available. Check the bot logs.`
            : [
                `**What this channel is:** Swing and hybrid trade signals for your manual trading.`,
                `The bot scans ${[...CRYPTO_ASSETS].map((s) => s.split('/')[0]).join(', ')} + XAU, XAG, QQQ, SPY every few minutes.`,
                `When a **SWING** or **HYBRID** setup scores highly, a signal card is posted here.`,
                `Scalp trades do NOT appear here — they go to #paper-trading only.`,
                '',
                `**Your job:** Review the signal, decide if you want to trade it on your exchange, click ✅ Entered, then 🔴 Close when you exit.`,
                '',
                `All slash commands are now ${guildId ? '**instantly available**' : 'registered globally (may take up to 1h)'}.`,
                '',
                '**Commands:** ' + commandList,
              ].join('\n')
        )
        .setFooter({ text: `${client.user?.tag} · Paper-trading runs separately in #paper-trading` })
        .setTimestamp();

      await (channel as TextChannel).send({ embeds: [embed] });
    }
  } catch (err) {
    logger.warn('Could not post startup message to #bot-signals:', err);
  }

  // --- #paper-trading ---
  if (config.discord.paperChannelId && config.discord.paperChannelId !== config.discord.signalChannelId) {
    try {
      const paperCh = await client.channels.fetch(config.discord.paperChannelId);
      if (paperCh?.isTextBased()) {
        const paperEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📄 #paper-trading — Automated Bot Learning Loop')
          .setDescription(
            [
              `**What this channel is:** The bot's own automated trading account — fully hands-off.`,
              '',
              `Every signal the bot generates (SWING, HYBRID, and SCALP) is auto-entered here in a **virtual $1,000 account**.`,
              `No action is needed from you — entries and exits happen automatically.`,
              '',
              `**Why it exists:** To measure the bot's raw strategy performance in real-time.`,
              `Every Sunday the bot analyses its own win rate by asset, hour, market regime, and indicator, then auto-tunes its parameters.`,
              '',
              `**Scheduled posts in this channel:**`,
              `• **12:00 UTC** — midday balance check-in`,
              `• **23:59 UTC** — full daily report (attach to Claude to improve the bot)`,
              `• **Sunday 00:00 UTC** — weekly self-improvement analysis`,
              '',
              `**This is separate from #bot-signals.** Same strategies, but different purpose:`,
              `#bot-signals = signals for YOU to trade manually`,
              `#paper-trading = the bot evaluating itself with zero risk`,
              '',
              `Use \`/paper-reset\` to wipe and restart the virtual account at any time.`,
            ].join('\n')
          )
          .setFooter({ text: `${client.user?.tag} · No real money is ever at risk` })
          .setTimestamp();

        await (paperCh as TextChannel).send({ embeds: [paperEmbed] });
      }
    } catch (err) {
      logger.warn('Could not post startup message to #paper-trading:', err);
    }
  }
}
