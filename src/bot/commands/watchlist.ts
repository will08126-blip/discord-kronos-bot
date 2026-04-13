import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Asset } from '../../types';
import { scanSingleAsset } from '../../engine';
import { buildWatchlistEmbed, buildSignalEmbed } from '../embeds';
import { addPendingSignal, markSignalSent } from '../../signals/signalManager';

const WATCHLIST: Asset[] = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'XRP/USDT',
  'PEPE/USDT',
];

export const data = new SlashCommandBuilder()
  .setName('watchlist')
  .setDescription('Instant scan of BTC, ETH, SOL, XRP, PEPE — scores, leverage, and deployment');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const results = await Promise.all(WATCHLIST.map((asset) => scanSingleAsset(asset)));

  // Compact summary embed
  await interaction.editReply(buildWatchlistEmbed(results));

  // Full signal embeds for every qualifying signal across all assets
  for (const result of results) {
    const qualifying = result.signals.filter((s) => s.tier !== 'NO_TRADE');
    for (const signal of qualifying) {
      const msg = await interaction.followUp(buildSignalEmbed(signal));
      addPendingSignal(signal);
      markSignalSent(signal);
      void msg; // message ref not needed here
    }
  }
}
