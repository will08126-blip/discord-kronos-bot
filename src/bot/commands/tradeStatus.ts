import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getAllActivePositions } from '../../signals/signalManager';
import { fetchCurrentPrice, fetchOHLCV } from '../../data/marketData';
import { formatPrice, formatPct } from '../../risk/riskCalculator';
import { rsi, ema } from '../../indicators/indicators';
import type { ActivePosition } from '../../types';

export const data = new SlashCommandBuilder()
  .setName('trade-status')
  .setDescription('Live grade & status of your open trade(s) — see how the trade is playing out')
  .addStringOption((opt) =>
    opt
      .setName('id')
      .setDescription('Position ID prefix (first 8 chars) — omit to show all open trades')
      .setRequired(false)
  );

// ─── Grading ──────────────────────────────────────────────────────────────────

interface TradeGrade {
  letter: string;
  emoji: string;
  color: number;
  rMultiple: number;
  pnlPct: number;
  progressPct: number;   // 0–100% of the way from entry price to TP price
  slDistancePct: number; // % distance remaining from current price to SL
  commentary: string;
}

/**
 * Calculates a letter grade (S / A+ / A / B / C / D / F) for a live position.
 *
 * Grade is driven primarily by R-multiple (how many risk units are currently
 * locked in) and % progress towards TP, with qualitative adjustments for
 * RSI momentum state and time overstay relative to the trade type.
 */
function gradePosition(
  position: ActivePosition,
  currentPrice: number,
  currentRsi: number
): TradeGrade {
  const isLong = position.signal.direction === 'LONG';
  const entry = position.entryPrice;
  const sl = position.currentStopLoss;
  const tp = position.currentTakeProfit;

  // Live P&L from entry (fraction)
  const pnlPct = isLong
    ? (currentPrice - entry) / entry
    : (entry - currentPrice) / entry;

  // Stop distance % — used as the R denominator
  const stopDistPct = Math.abs(entry - sl) / entry;
  const rMultiple = stopDistPct > 0 ? pnlPct / stopDistPct : 0;

  // Progress from entry towards TP (0% = at entry, 100% = at TP)
  const totalMove = Math.abs(tp - entry);
  const currentMove = isLong ? currentPrice - entry : entry - currentPrice;
  const progressPct = totalMove > 0
    ? Math.max(-999, Math.min(150, (currentMove / totalMove) * 100))
    : 0;

  // Distance from current price to SL (as % of current price)
  const slDistancePct = isLong
    ? ((currentPrice - sl) / currentPrice) * 100
    : ((sl - currentPrice) / currentPrice) * 100;

  // Time-overstay check
  const heldHours = (Date.now() - position.confirmedAt) / (1000 * 60 * 60);
  const typicalHours =
    position.signal.tradeType === 'SCALP' ? 1
    : position.signal.tradeType === 'HYBRID' ? 4
    : 24;
  const isOverstayed = heldHours > typicalHours * 1.5;

  // RSI momentum signals
  const rsiOverbought = isLong ? currentRsi > 75 : currentRsi < 25;
  const rsiMomentumFailed = !isNaN(currentRsi) && (isLong ? currentRsi < 40 : currentRsi > 60);

  // ── Letter grade ──────────────────────────────────────────────────────────
  let letter: string;
  let emoji: string;
  let color: number;
  let commentary: string;

  if (progressPct >= 100) {
    // Price at or past TP — exceptional
    letter = 'S';
    emoji = '🌟';
    color = 0xFFD700;
    commentary = 'Price has reached or exceeded the take-profit target — outstanding execution!';
    if (position.tpExtensionCount > 0) {
      commentary += ` TP was extended ${position.tpExtensionCount}× by momentum — excellent trade management.`;
    }
  } else if (rMultiple >= 1.0 && progressPct >= 50) {
    // Strong profit, well past halfway
    letter = 'A+';
    emoji = '🟢';
    color = 0x00CC44;
    commentary = `Excellent — ${rMultiple.toFixed(2)}R gained and more than halfway to TP.`;
    if (rsiOverbought) commentary += ' RSI is extended; consider tightening the stop to protect gains.';
  } else if (rMultiple >= 0.5 || progressPct >= 33) {
    // Good profit / solid progress
    letter = 'A';
    emoji = '🟢';
    color = 0x22CC66;
    commentary = `Good progress — ${rMultiple.toFixed(2)}R locked in with ${progressPct.toFixed(0)}% of the move complete.`;
    if (rsiOverbought) commentary += ' RSI is overextended; watch for a short-term pullback.';
  } else if (rMultiple >= 0.2 || progressPct >= 15) {
    // Early profit, trade is working
    letter = 'B';
    emoji = '🟡';
    color = 0x88CC00;
    commentary = `Trade is progressing positively (${rMultiple.toFixed(2)}R). Still early — let it develop.`;
  } else if (rMultiple >= 0) {
    // Flat or marginal profit
    letter = 'C';
    emoji = '🟡';
    color = 0xFFCC00;
    commentary = 'Trade is flat or marginally profitable. Setup is still valid — patience required.';
    if (isOverstayed) {
      commentary += ` Trade has been open ${heldHours.toFixed(1)}h, which is longer than typical for a ${position.signal.tradeType}.`;
    }
  } else if (rMultiple >= -0.5) {
    // Small loss — losing ground
    letter = 'D';
    emoji = '🟠';
    color = 0xFF8800;
    commentary = `Trade is losing ground (${rMultiple.toFixed(2)}R). SL is ${Math.max(0, slDistancePct).toFixed(2)}% away — monitor closely.`;
    if (rsiMomentumFailed) commentary += ' Momentum indicators are turning against the trade.';
  } else {
    // Significant loss — approaching SL
    letter = 'F';
    emoji = '🔴';
    color = 0xFF2200;
    commentary = `Significant drawdown (${rMultiple.toFixed(2)}R). SL is only ${Math.max(0, slDistancePct).toFixed(2)}% away.`;
    if (rsiMomentumFailed) commentary += ' Momentum has failed — consider cutting the loss early to preserve capital.';
  }

  // Append overstay note for non-critical grades
  if (isOverstayed && letter !== 'F' && letter !== 'D' && letter !== 'C') {
    commentary += ` Note: held ${heldHours.toFixed(1)}h — longer than the typical ${position.signal.tradeType} window.`;
  }

  return { letter, emoji, color, rMultiple, pnlPct, progressPct, slDistancePct, commentary };
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

/** Text-based progress bar: ████░░░░░░░░ — shows % of move from entry to TP */
function buildProgressBar(progressPct: number): string {
  const SEGMENTS = 12;
  const filled = Math.max(0, Math.min(SEGMENTS, Math.round((progressPct / 100) * SEGMENTS)));
  const bar = '█'.repeat(filled) + '░'.repeat(SEGMENTS - filled);
  const pct = Math.max(0, progressPct).toFixed(0);
  return `\`[${bar}]\` ${pct}% to TP`;
}

// ─── Embed builder ───────────────────────────────────────────────────────────

async function buildStatusEmbed(position: ActivePosition): Promise<EmbedBuilder> {
  const asset = position.signal.asset;
  const assetBase = asset.split('/')[0];
  const isLong = position.signal.direction === 'LONG';

  // Fetch live price and 5m candles in parallel
  const [currentPrice, candles5m] = await Promise.all([
    fetchCurrentPrice(asset),
    fetchOHLCV(asset, '5m'),
  ]);

  // Live technical indicators
  const rsiVals = rsi(candles5m, 14);
  const emaVals = ema(candles5m, 9);
  const currentRsi = rsiVals[rsiVals.length - 1] ?? NaN;
  const currentEma = emaVals[emaVals.length - 1] ?? NaN;

  const grade = gradePosition(position, currentPrice, currentRsi);

  // Human-readable time held
  const heldMin = Math.round((Date.now() - position.confirmedAt) / 60_000);
  const heldDisplay = heldMin >= 60
    ? `${Math.floor(heldMin / 60)}h ${heldMin % 60}m`
    : `${heldMin}m`;

  // EMA status line
  const emaStatus = !isNaN(currentEma)
    ? (isLong
        ? currentPrice > currentEma ? '✅ Price above EMA(9)' : '⚠️ Price below EMA(9)'
        : currentPrice < currentEma ? '✅ Price below EMA(9)' : '⚠️ Price above EMA(9)')
    : 'EMA N/A';

  // RSI display with signal tag
  const rsiDisplay = !isNaN(currentRsi) ? currentRsi.toFixed(1) : 'N/A';
  const rsiTag = !isNaN(currentRsi)
    ? (isLong
        ? currentRsi > 70 ? ' ⚠️ Overbought' : currentRsi < 40 ? ' ⚠️ Weakening' : ' ✅ Healthy'
        : currentRsi < 30 ? ' ⚠️ Oversold' : currentRsi > 60 ? ' ⚠️ Weakening' : ' ✅ Healthy')
    : '';

  const rMultipleStr = `${grade.rMultiple >= 0 ? '+' : ''}${grade.rMultiple.toFixed(2)}R`;

  return new EmbedBuilder()
    .setColor(grade.color)
    .setTitle(`${grade.emoji} ${assetBase} ${position.signal.direction} — Grade: ${grade.letter}`)
    .setDescription(`> ${grade.commentary}`)
    .addFields(
      {
        name: '💰 Prices',
        value: [
          `Entry:   **${formatPrice(position.entryPrice, assetBase)}**`,
          `Current: **${formatPrice(currentPrice, assetBase)}**`,
          `SL:      ${formatPrice(position.currentStopLoss, assetBase)}`,
          `TP:      ${formatPrice(position.currentTakeProfit, assetBase)}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📊 Performance',
        value: [
          `P&L:    **${formatPct(grade.pnlPct)}**`,
          `R-mult: **${rMultipleStr}**`,
          `SL gap: ${Math.max(0, grade.slDistancePct).toFixed(2)}% away`,
          `Held:   ${heldDisplay}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📈 Indicators (5m)',
        value: [
          `RSI(14): ${rsiDisplay}${rsiTag}`,
          emaStatus,
          `TP extensions: ${position.tpExtensionCount}/2 used`,
          `Score: ${position.signal.score} (${position.signal.tier})`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '🎯 Progress to TP',
        value: buildProgressBar(grade.progressPct),
        inline: false,
      }
    )
    .setFooter({
      text: `ID: ${position.id.slice(0, 8)} • ${position.signal.strategy} • Regime: ${position.signal.regime} • Type: ${position.signal.tradeType}`,
    })
    .setTimestamp();
}

// ─── Command handler ──────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const idArg = interaction.options.getString('id');

  await interaction.deferReply({ ephemeral: true });

  let positions = getAllActivePositions();

  if (positions.length === 0) {
    await interaction.editReply({ content: '📭 No active positions to evaluate.' });
    return;
  }

  if (idArg) {
    const match = positions.find((p) => p.id.startsWith(idArg));
    if (!match) {
      await interaction.editReply({
        content: `❌ No active position found with ID starting with \`${idArg}\`.\nUse \`/positions\` to see your active position IDs.`,
      });
      return;
    }
    positions = [match];
  }

  // Build all embeds in parallel (one per position)
  const embeds = await Promise.all(positions.map(buildStatusEmbed));
  await interaction.editReply({ embeds });
}
