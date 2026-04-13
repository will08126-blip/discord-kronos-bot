import { Events } from 'discord.js';
import { discordClient } from './bot/client';
import { onReady } from './bot/events/ready';
import { onInteractionCreate } from './bot/events/interactionCreate';
import { startScheduler, runScanCycle } from './engine';
import { loadPositions } from './signals/signalManager';
import { config } from './config';
import { logger } from './utils/logger';

// ─── Global error guards ──────────────────────────────────────────────────────
// Without these, a single unhandled rejection crashes Node 15+ (Render uses 20+).

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled promise rejection:', reason);
  // Do NOT exit — log and keep the bot alive for the next interaction.
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception — restarting:', err);
  process.exit(1); // Render will auto-restart the worker
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  // Give any in-flight async operations up to 5 seconds before exiting.
  // All file writes are synchronous so they will complete before this fires.
  setTimeout(() => {
    logger.info('Graceful shutdown complete');
    process.exit(0);
  }, 5000).unref();
});

async function main() {
  logger.info('Starting Discord Trading Bot...');

  // Restore active positions from the previous session before anything else
  loadPositions();

  // Register Discord event handlers
  discordClient.once(Events.ClientReady, async (client) => {
    await onReady(client);
    startScheduler();

    // Run one scan immediately on startup so you don't wait 5 minutes
    logger.info('Running initial scan...');
    setTimeout(() => {
      runScanCycle().catch((err) => logger.error('Initial scan error:', err));
    }, 3000); // small delay to let Discord settle
  });

  discordClient.on(Events.InteractionCreate, onInteractionCreate);

  discordClient.on(Events.Error, (err) => {
    logger.error('Discord client error:', err);
  });

  discordClient.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    logger.warn(`Discord shard ${shardId} disconnected (code ${closeEvent.code})`);
  });

  discordClient.on(Events.ShardReconnecting, (shardId) => {
    logger.info(`Discord shard ${shardId} reconnecting...`);
  });

  discordClient.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info(`Discord shard ${shardId} resumed (replayed ${replayedEvents} events)`);
  });

  discordClient.on(Events.Invalidated, () => {
    logger.error('Discord session invalidated — restarting process');
    process.exit(1); // Render auto-restarts; invalidated sessions cannot be recovered
  });

  // Login
  await discordClient.login(config.discord.token);
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
