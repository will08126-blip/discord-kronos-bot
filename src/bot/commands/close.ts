import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getAllActivePositions, closePositionManually } from '../../signals/signalManager';
import { buildClosedTradeEmbed } from '../embeds';

export const data = new SlashCommandBuilder()
  .setName('close')
  .setDescription('Record that you manually closed a position')
  .addNumberOption((opt) =>
    opt
      .setName('price')
      .setDescription('The price at which you exited the trade')
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName('id')
      .setDescription('Position ID prefix (leave blank if only one trade is open)')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const shortId = interaction.options.getString('id')?.trim() ?? null;
  const exitPrice = interaction.options.getNumber('price', true);

  const positions = getAllActivePositions();

  let position;
  if (shortId) {
    // ID was provided — match by prefix
    position = positions.find((p) => p.id.startsWith(shortId));
    if (!position) {
      await interaction.reply({
        content: `❌ No active position found with ID starting with \`${shortId}\`. Use \`/positions\` to see active positions.`,
        ephemeral: true,
      });
      return;
    }
  } else {
    // No ID — auto-select if exactly one position is active
    if (positions.length === 0) {
      await interaction.reply({
        content: '❌ No active positions to close.',
        ephemeral: true,
      });
      return;
    }
    if (positions.length > 1) {
      const list = positions
        .map((p) => `• \`${p.id.slice(0, 8)}\` — ${p.signal.asset.split('/')[0]} ${p.signal.direction}`)
        .join('\n');
      await interaction.reply({
        content: `❌ Multiple active positions — please specify an ID:\n${list}\n\nExample: \`/close id:${positions[0].id.slice(0, 8)} price:${exitPrice}\``,
        ephemeral: true,
      });
      return;
    }
    position = positions[0];
  }

  const trade = closePositionManually(position.id, exitPrice);
  if (!trade) {
    await interaction.reply({ content: '❌ Failed to close position.', ephemeral: true });
    return;
  }

  const msg = buildClosedTradeEmbed(trade);
  await interaction.reply(msg);
}
