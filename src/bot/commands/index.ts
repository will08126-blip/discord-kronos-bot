import { REST, Routes } from 'discord.js';
import { config } from '../../config';
import { logger } from '../../utils/logger';

import * as statusCmd from './status';
import * as positionsCmd from './positions';
import * as closeCmd from './close';
import * as performanceCmd from './performance';
import * as toggleCmd from './toggle';
import * as reportCmd from './report';
import * as scanCmd from './scan';
import * as historyCmd from './history';
import * as helpCmd from './help';
import * as configCmd from './config';
import * as checkCmd from './check';
import * as liveCmd from './live';
import * as tradeStatusCmd from './tradeStatus';
import * as filterCmd from './filter';
import * as weightsCmd from './weights';
import * as pulseCmd from './pulse';
import * as paperStatusCmd from './paper-status';
import * as paperPositionsCmd from './paper-positions';
import * as paperHistoryCmd from './paper-history';
import * as paperPerformanceCmd from './paper-performance';
import * as dailyReportCmd from './daily-report';
import * as paperResetCmd from './paper-reset';

export interface Command {
  data: { toJSON: () => unknown; name: string };
  execute: (interaction: any) => Promise<void>;
}

export const commands = new Map<string, Command>([
  ['pulse', pulseCmd],
  ['filter', filterCmd],
  ['weights', weightsCmd],
  ['status', statusCmd],
  ['positions', positionsCmd],
  ['close', closeCmd],
  ['performance', performanceCmd],
  ['toggle', toggleCmd],
  ['report', reportCmd],
  ['scan', scanCmd],
  ['history', historyCmd],
  ['help', helpCmd],
  ['config', configCmd],
  ['check', checkCmd],
  ['live', liveCmd],
  ['trade-status', tradeStatusCmd],
  ['paper-status', paperStatusCmd],
  ['paper-positions', paperPositionsCmd],
  ['paper-history', paperHistoryCmd],
  ['paper-performance', paperPerformanceCmd],
  ['daily-report', dailyReportCmd],
  ['paper-reset', paperResetCmd],
]);

/** Deploy (register) all slash commands with Discord's API */
export async function deployCommands(guildId?: string): Promise<void> {
  const rest = new REST().setToken(config.discord.token);

  // Deduplicate by command name — prevents double-registering if same data object is
  // referenced by multiple map entries. Each Discord command name must be unique.
  const seen = new Set<string>();
  const commandBodies = [...commands.values()]
    .filter((c) => {
      if (seen.has(c.data.name)) return false;
      seen.add(c.data.name);
      return true;
    })
    .map((c) => c.data.toJSON());

  try {
    if (guildId) {
      // Guild-scoped (instant update, available immediately)
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, guildId),
        { body: commandBodies }
      );
      logger.info(`Deployed ${commandBodies.length} guild commands to guild ${guildId}`);

      // Clear any stale global commands — if both guild and global commands exist for the
      // same bot they show as duplicates in Discord's slash command menu.
      await rest.put(Routes.applicationCommands(config.discord.clientId), { body: [] });
      logger.info('Cleared global commands to prevent duplicate entries in Discord');
    } else {
      // Global commands (up to 1h propagation delay)
      await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commandBodies }
      );
      logger.info(`Deployed ${commandBodies.length} global commands`);
    }
  } catch (err) {
    logger.error('Failed to deploy commands:', err);
    throw err; // re-throw so ready.ts can surface the failure
  }
}
