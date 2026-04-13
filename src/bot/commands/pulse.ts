import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getAllActivePositions, savePositions } from '../../signals/signalManager';
import { fetchOHLCV, fetchCurrentPrice } from '../../data/marketData';
import { cachedRsi, cachedEma, cachedVwap } from '../../indicators/cache';
import { volumeAverage } from '../../indicators/indicators';
import { buildPositionHealthEmbed } from '../embeds';
import type { Asset } from '../../types';

export const data = new SlashCommandBuilder()
  .setName('pulse')
  .setDescription('Force an immediate health check on all open positions — no need to wait 15 min');

export async function execute(interaction: ChatInputCommandInteraction) {
  const positions = getAllActivePositions();

  if (positions.length === 0) {
    await interaction.reply({
      content: [
        '📭 **No open positions to check.**',
        '',
        'Confirm a trade first by clicking the **✅ Entered LONG/SHORT** button on a signal.',
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const errors: string[] = [];
  let firstReplyDone = false;

  for (const position of positions) {
    try {
      const asset = position.signal.asset as Asset;
      const [candles5m, candles15m, currentPrice] = await Promise.all([
        fetchOHLCV(asset, '5m'),
        fetchOHLCV(asset, '15m'),
        fetchCurrentPrice(asset),
      ]);

      // 5m indicators
      const rsiVals5m = cachedRsi(candles5m, 14);
      const ema9Vals  = cachedEma(candles5m, 9);
      const vwapVals  = cachedVwap(candles5m);
      const rsi14     = rsiVals5m[rsiVals5m.length - 1] ?? NaN;
      const ema9      = ema9Vals[ema9Vals.length - 1] ?? NaN;
      const vwap      = vwapVals[vwapVals.length - 1] ?? NaN;

      // RSI slope: compare current RSI to 3 bars ago
      const rsiPrev3  = rsiVals5m[rsiVals5m.length - 4] ?? NaN;
      const rsiSlope: 'rising' | 'flat' | 'falling' =
        !isNaN(rsi14) && !isNaN(rsiPrev3)
          ? rsi14 - rsiPrev3 > 2 ? 'rising' : rsiPrev3 - rsi14 > 2 ? 'falling' : 'flat'
          : 'flat';

      // Volume ratio vs 20-bar average
      const avgVol = volumeAverage(candles5m, 20);
      const lastVol = candles5m[candles5m.length - 1]?.volume ?? 0;
      const volumeRatio = avgVol > 0 ? lastVol / avgVol : undefined;

      // 15m indicators
      const ema21Vals15m = cachedEma(candles15m, 21);
      const ema21_15m    = ema21Vals15m[ema21Vals15m.length - 1] ?? NaN;

      // Reset the 15-min timer so the next auto-check is 15 min from now
      position.lastHealthUpdatePrice = currentPrice;
      position.lastHealthUpdateAt = Date.now();
      savePositions();

      const payload = buildPositionHealthEmbed(position, currentPrice, {
        rsi14, ema9, rsiSlope, ema21_15m, vwap, volumeRatio,
      }, 'PULSE');

      if (!firstReplyDone) {
        // Replace the "Bot is thinking…" placeholder — keeps the message alive permanently
        await interaction.editReply(payload);
        firstReplyDone = true;
      } else {
        await interaction.followUp(payload);
      }
    } catch (err) {
      errors.push(`⚠️ Failed to check ${position.signal.asset}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    const errPayload = { content: errors.join('\n'), ephemeral: true };
    if (!firstReplyDone) {
      await interaction.editReply(errors.join('\n'));
    } else {
      await interaction.followUp(errPayload);
    }
  }
}

