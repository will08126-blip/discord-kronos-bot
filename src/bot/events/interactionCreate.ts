import type { Interaction } from 'discord.js';
import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { commands } from '../commands/index';
import {
  getPendingSignal,
  confirmEntry,
  dismissPendingSignal,
  getActivePosition,
  closePositionManually,
} from '../../signals/signalManager';
import { buildPositionEmbed, buildClosedTradeEmbed } from '../embeds';
import { fetchCurrentPrice } from '../../data/marketData';
import type { Asset } from '../../types';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export async function onInteractionCreate(interaction: Interaction): Promise<void> {
  // ── Slash commands ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    if (!command) {
      // Unknown command — always reply so Discord doesn't show "Application did not respond"
      logger.warn(`Unknown command received: /${interaction.commandName}`);
      try {
        await interaction.reply({ content: '⚠️ Unknown command. The bot may still be starting up — try again in a moment.', ephemeral: true });
      } catch { /* token already expired */ }
      return;
    }
    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error(`Command /${interaction.commandName} error:`, err);
      const msg = { content: `❌ An error occurred running \`/${interaction.commandName}\`. Please try again.`, ephemeral: true };
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(msg);
        } else {
          await interaction.reply(msg);
        }
      } catch (replyErr) {
        // Interaction token likely expired (e.g. CCXT hung for >15 min).
        logger.warn(`Could not send error response for /${interaction.commandName}:`, replyErr);
      }
    }
    return;
  }

  // ── Button interactions ────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const colonIdx = interaction.customId.indexOf(':');
    if (colonIdx === -1) return; // malformed customId — ignore
    const action = interaction.customId.slice(0, colonIdx);
    const payload = interaction.customId.slice(colonIdx + 1);

    if (action === 'dismiss') {
      dismissPendingSignal(payload);
      await interaction.update({ content: '❌ Signal dismissed.', embeds: [], components: [] });
      return;
    }

    if (action === 'enter') {
      const signal = getPendingSignal(payload);
      if (!signal) {
        await interaction.reply({ content: '⚠️ Signal expired or already confirmed.', ephemeral: true });
        return;
      }

      // Use the midpoint of the entry zone as the assumed entry price
      const entryPrice = (signal.entryZone[0] + signal.entryZone[1]) / 2;

      const position = confirmEntry(
        payload,
        entryPrice,
        interaction.message.id,
        interaction.channelId
      );

      if (!position) {
        await interaction.reply({
          content: `⚠️ Could not confirm — max positions (${config.trading.maxOpenPositions}) already reached.`,
          ephemeral: true,
        });
        return;
      }

      // Update the original signal message to remove buttons, then post tracking embed
      await interaction.update({ components: [] });

      const trackMsg = buildPositionEmbed(position);
      await interaction.followUp(trackMsg);

      logger.info(`Position confirmed via button: ${signal.asset} ${signal.direction} @ ${entryPrice}`);
      return;
    }

    if (action === 'closePosition') {
      const positionId = payload;
      const position = getActivePosition(positionId);

      if (!position) {
        await interaction.reply({
          content: '⚠️ This position is no longer active — it may have already been closed.',
          ephemeral: true,
        });
        return;
      }

      const asset = position.signal.asset.split('/')[0];

      // Fetch current live market price to pre-fill the modal
      let priceValue: string | undefined;
      try {
        const currentPrice = await fetchCurrentPrice(position.signal.asset as Asset);
        if (currentPrice > 0) {
          // Format price based on asset magnitude
          const decimals = currentPrice < 0.01 ? 8 : currentPrice < 1 ? 6 : 2;
          priceValue = currentPrice.toFixed(decimals);
        }
      } catch (err) {
        logger.warn(`Could not fetch current price for ${position.signal.asset}:`, err);
        // Modal will show with empty input so user can type manually
      }

      const modal = new ModalBuilder()
        .setCustomId(`closeModal:${positionId}`)
        .setTitle(`Close ${asset} ${position.signal.direction}`);

      const priceInput = new TextInputBuilder()
        .setCustomId('exitPrice')
        .setLabel('Exit Price')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 65432.00')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(20);

      if (priceValue !== undefined) {
        priceInput.setValue(priceValue);
      }

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(priceInput)
      );

      await interaction.showModal(modal);
      return;
    }
  }

  // ── Modal submissions ──────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    const colonIdx = interaction.customId.indexOf(':');
    if (colonIdx === -1) return; // malformed customId — ignore
    const modalAction = interaction.customId.slice(0, colonIdx);
    const positionId = interaction.customId.slice(colonIdx + 1);

    if (modalAction === 'closeModal') {
      await interaction.deferReply();

      const rawPrice = interaction.fields.getTextInputValue('exitPrice').trim();
      const exitPrice = parseFloat(rawPrice);

      if (isNaN(exitPrice) || exitPrice <= 0) {
        await interaction.editReply({
          content: `❌ Invalid price: \`${rawPrice}\` — please enter a positive number (e.g. \`65432.10\`).`,
        });
        return;
      }

      // Re-check: position could have been auto-closed by SL/TP between button click and submit
      const position = getActivePosition(positionId);
      if (!position) {
        await interaction.editReply({
          content: '⚠️ Position no longer active — it may have been automatically closed by a stop loss or take profit.',
        });
        return;
      }

      const trade = closePositionManually(positionId, exitPrice);
      if (!trade) {
        await interaction.editReply({
          content: '❌ Failed to close position. Try `/close` as a fallback.',
        });
        return;
      }

      const msg = buildClosedTradeEmbed(trade);
      await interaction.editReply(msg);
      return;
    }
  }
}
