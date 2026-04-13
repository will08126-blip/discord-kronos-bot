import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { toggleBot } from '../../adaptation/adaptation';
import { config } from '../../config';

export const data = new SlashCommandBuilder()
  .setName('toggle')
  .setDescription('Enable or disable signal scanning')
  .addStringOption((opt) =>
    opt
      .setName('state')
      .setDescription('Turn scanning on or off')
      .setRequired(true)
      .addChoices(
        { name: 'On — enable scanning', value: 'on' },
        { name: 'Off — disable scanning', value: 'off' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const state = interaction.options.getString('state', true);
  const enabled = state === 'on';
  toggleBot(enabled);
  await interaction.reply({
    content: enabled
      ? `✅ Bot **enabled** — scanning for setups every ${config.engine.scanIntervalMinutes} minutes.`
      : '⛔ Bot **disabled** — no new signals will be posted until you re-enable.',
    ephemeral: false,
  });
}
