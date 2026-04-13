import { SlashCommandBuilder, ChatInputCommandInteraction, Message, EmbedBuilder } from 'discord.js';
import type { Asset } from '../../types';
import { scanSingleAsset } from '../../engine';
import { buildWatchlistEmbed } from '../embeds';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const WATCHLIST: Asset[] = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'XRP/USDT',
  'PEPE/USDT',
  'XAU/USD',
  'XAG/USD',
  'QQQ/USD',
  'SPY/USD',
];

// Module-scoped state — only one live dashboard active at a time
let liveDashboard: {
  timer: ReturnType<typeof setInterval>;
  message: Message;
} | null = null;

export const data = new SlashCommandBuilder()
  .setName('live')
  .setDescription('Auto-updating watchlist: BTC, ETH, SOL, XRP, PEPE + Gold, Silver, QQQ, SPY')
  .addStringOption((opt) =>
    opt
      .setName('action')
      .setDescription('start (default) or stop')
      .setRequired(false)
      .addChoices({ name: 'start', value: 'start' }, { name: 'stop', value: 'stop' })
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const action = (interaction.options.getString('action') ?? 'start') as 'start' | 'stop';

  // ── Stop ──────────────────────────────────────────────────────────────────
  if (action === 'stop') {
    if (!liveDashboard) {
      await interaction.reply({ content: 'No live dashboard is currently running.', ephemeral: true });
      return;
    }

    clearInterval(liveDashboard.timer);
    try {
      await liveDashboard.message.edit({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4444)
            .setTitle('🔴 Live Watchlist — Stopped')
            .setDescription('Dashboard was stopped via `/live stop`.')
            .setTimestamp(),
        ],
      });
    } catch (err) {
      logger.warn('Could not edit stopped live dashboard message:', err);
    }
    liveDashboard = null;
    await interaction.reply({ content: '✅ Live dashboard stopped.', ephemeral: true });
    return;
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  if (liveDashboard) {
    // Verify the tracked message still exists — it may have been deleted in Discord
    let messageStillExists = true;
    try {
      await liveDashboard.message.fetch();
    } catch {
      messageStillExists = false;
    }

    if (messageStillExists) {
      await interaction.reply({
        content: 'A live dashboard is already running. Use `/live stop` first.',
        ephemeral: true,
      });
      return;
    }

    // Message was deleted — clean up stale state and allow a new dashboard to start
    clearInterval(liveDashboard.timer);
    liveDashboard = null;
    logger.warn('Live dashboard message was deleted externally — resetting state');
  }

  await interaction.deferReply();

  const results = await Promise.all(WATCHLIST.map((asset) => scanSingleAsset(asset)));
  // editReply() returns the Message directly in discord.js v14 — no extra fetch needed
  const message = (await interaction.editReply(buildWatchlistEmbed(results, true))) as Message;

  const intervalMs = config.engine.scanIntervalMinutes * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      const fresh = await Promise.all(WATCHLIST.map((asset) => scanSingleAsset(asset)));
      await message.edit(buildWatchlistEmbed(fresh, true));
    } catch (err) {
      logger.error('Live dashboard refresh error:', err);
    }
  }, intervalMs);

  liveDashboard = { timer, message };
  logger.info(`Live dashboard started — refreshing every ${config.engine.scanIntervalMinutes} min`);
}
