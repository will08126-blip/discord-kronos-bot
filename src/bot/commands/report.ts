import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { generateDailySummary, generateWeeklySummary } from '../../llm/summaries';
import { buildSummaryEmbed } from '../embeds';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export const data = new SlashCommandBuilder()
  .setName('report')
  .setDescription('Generate a performance report using AI')
  .addStringOption((opt) =>
    opt
      .setName('type')
      .setDescription('Report type')
      .setRequired(true)
      .addChoices(
        { name: 'Daily', value: 'daily' },
        { name: 'Weekly', value: 'weekly' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const type = interaction.options.getString('type', true) as 'daily' | 'weekly';
  await interaction.deferReply();

  const result = type === 'daily'
    ? await generateDailySummary()
    : await generateWeeklySummary();

  const embed = buildSummaryEmbed(type, result.stats, result.aiText, result.label);
  await interaction.editReply(embed);

  // Also post to summary channel if this command was run from a different channel
  const summaryChannelId = config.discord.summaryChannelId;
  if (summaryChannelId && interaction.channelId !== summaryChannelId) {
    try {
      const summaryChannel = await interaction.client.channels.fetch(summaryChannelId).catch(() => null);
      if (summaryChannel?.isTextBased()) {
        await (summaryChannel as TextChannel).send(embed);
      } else if (summaryChannelId) {
        logger.warn(`/report: summary channel ${summaryChannelId} not found or not a text channel`);
      }
    } catch (err) {
      logger.warn('/report: failed to post to summary channel:', err);
    }
  }
}
