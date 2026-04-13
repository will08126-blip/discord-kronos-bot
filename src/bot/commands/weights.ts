import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import {
  loadState,
  resetStrategyWeights,
  setStrategyWeight,
  RECOMMENDED_WEIGHTS,
} from '../../adaptation/adaptation';

const STRATEGY_NAMES = ['Trend Pullback', 'Breakout Retest', 'Liquidity Sweep', 'Volatility Expansion'];

// Which strategies the user has marked as priorities — shown with a star
const USER_PRIORITY = new Set(['Trend Pullback', 'Breakout Retest', 'Liquidity Sweep']);

function weightBar(weight: number): string {
  const filled = Math.round(weight * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const pct = `${(weight * 100).toFixed(0)}%`;
  const status = weight >= 0.90 ? '🟢' : weight >= 0.70 ? '🟡' : '🔴';
  return `${status} ${bar}  ${pct}`;
}

export const data = new SlashCommandBuilder()
  .setName('weights')
  .setDescription('View and manage strategy signal weights')
  .addSubcommand((sub) =>
    sub.setName('view').setDescription('Show current strategy weights')
  )
  .addSubcommand((sub) =>
    sub.setName('reset').setDescription('Reset all weights to recommended defaults (clears tainted historical data)')
  )
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Manually set a single strategy weight (0.50–1.0)')
      .addStringOption((opt) =>
        opt
          .setName('strategy')
          .setDescription('Which strategy to adjust')
          .setRequired(true)
          .addChoices(
            { name: 'Trend Pullback',      value: 'Trend Pullback'      },
            { name: 'Breakout Retest',     value: 'Breakout Retest'     },
            { name: 'Liquidity Sweep',     value: 'Liquidity Sweep'     },
            { name: 'Volatility Expansion',value: 'Volatility Expansion' },
          )
      )
      .addNumberOption((opt) =>
        opt
          .setName('value')
          .setDescription('Weight from 0.50 (heavily reduced) to 1.0 (full signal strength)')
          .setRequired(true)
          .setMinValue(0.50)
          .setMaxValue(1.0)
      )
  );

function buildWeightsEmbed(title: string, description: string): EmbedBuilder {
  const state = loadState();

  const lines = STRATEGY_NAMES.map((name) => {
    const w = state.strategyWeights[name] ?? 1.0;
    const rec = RECOMMENDED_WEIGHTS[name] ?? 1.0;
    const priority = USER_PRIORITY.has(name) ? '★' : '◇';
    const drift = Math.abs(w - rec) > 0.05
      ? ` *(was ${(rec * 100).toFixed(0)}% recommended)*`
      : '';
    return `${priority} **${name}**\n${weightBar(w)}${drift}`;
  });

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`⚖️ ${title}`)
    .setDescription(description)
    .addFields(
      {
        name: 'Current Weights',
        value: lines.join('\n\n'),
        inline: false,
      },
      {
        name: 'How weights work',
        value: [
          '★ = your priority setups   ◇ = bonus signal',
          'Weights are auto-adjusted by the adaptation system based on recent win rates.',
          'They drop when a strategy underperforms and recover as it wins again.',
          '`/weights reset` — restore recommended starting point',
          '`/weights set` — manually pin a specific strategy',
        ].join('\n'),
        inline: false,
      }
    )
    .setTimestamp()
    .setFooter({ text: 'Weights persist across restarts • Adaptation continues from current values' });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'view') {
    await interaction.reply({
      embeds: [buildWeightsEmbed('Strategy Weights', 'Live view of how each strategy is currently weighted.')],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'reset') {
    resetStrategyWeights();
    await interaction.reply({
      embeds: [
        buildWeightsEmbed(
          'Strategy Weights — Reset Complete',
          '✅ All weights restored to recommended defaults.\n' +
          'Trend Pullback, Breakout Retest, and Liquidity Sweep are at **100%**. ' +
          'Volatility Expansion is at **85%** (lower priority).\n' +
          'The adaptation system will adjust from here as new trades complete.'
        ),
      ],
    });
    return;
  }

  if (sub === 'set') {
    const strategy = interaction.options.getString('strategy', true);
    const value    = interaction.options.getNumber('value', true);
    setStrategyWeight(strategy, value);
    await interaction.reply({
      embeds: [
        buildWeightsEmbed(
          'Strategy Weights — Updated',
          `✅ **${strategy}** weight set to **${(value * 100).toFixed(0)}%**.\n` +
          'The adaptation system will continue auto-adjusting from this new baseline.'
        ),
      ],
    });
  }
}
