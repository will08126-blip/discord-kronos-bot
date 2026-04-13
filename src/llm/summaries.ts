import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import {
  buildDailySummaryContext,
  buildWeeklySummaryContext,
  computeStats,
  loadTrades,
} from '../performance/tracker';
import { logger } from '../utils/logger';
import type { ClosedTrade, PerformanceStats } from '../types';

export interface SummaryResult {
  stats: PerformanceStats;
  aiText: string | null;
  label: string;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!config.anthropic.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set — LLM summaries disabled');
    }
    client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return client;
}

async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}

const SYSTEM_PROMPT = `You are a professional trading performance analyst.
You analyze crypto futures trading data and provide concise, actionable summaries.
Keep responses under 400 words. Use plain text — no markdown headers, just short paragraphs.
Be direct. Focus on patterns, what worked, what didn't, and key takeaways.
Never provide financial advice or tell the trader what to do next.`;

// ─── Daily Summary ─────────────────────────────────────────────────────────

export async function generateDailySummary(): Promise<SummaryResult> {
  const today = new Date().toISOString().slice(0, 10);
  const label = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const stats = computeStats(
    loadTrades().filter((t) => new Date(t.closedAt).toISOString().slice(0, 10) === today)
  );

  if (stats.totalTrades === 0) {
    return { stats, aiText: null, label };
  }

  try {
    const context = buildDailySummaryContext();
    const aiText = await callClaude(
      SYSTEM_PROMPT,
      `Here is today's trading data:\n\n${context}\n\nPlease provide a brief daily performance summary.`
    );
    return { stats, aiText, label };
  } catch (err) {
    logger.error('Daily summary AI call failed:', err);
    return { stats, aiText: null, label };
  }
}

// ─── Weekly Summary ────────────────────────────────────────────────────────

export async function generateWeeklySummary(): Promise<SummaryResult> {
  const label = 'Last 7 Days';
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const stats = computeStats(loadTrades().filter((t) => t.closedAt >= weekAgo));

  if (stats.totalTrades === 0) {
    return { stats, aiText: null, label };
  }

  try {
    const context = buildWeeklySummaryContext();
    const aiText = await callClaude(
      SYSTEM_PROMPT,
      `Here is this week's trading data:\n\n${context}\n\nPlease provide a weekly performance summary with key insights.`
    );
    return { stats, aiText, label };
  } catch (err) {
    logger.error('Weekly summary AI call failed:', err);
    return { stats, aiText: null, label };
  }
}

// ─── Trade Anomaly Explanation ─────────────────────────────────────────────

export async function explainTrade(trade: ClosedTrade): Promise<string> {
  try {
    const dir = trade.signal.direction;
    const asset = trade.signal.asset.split('/')[0];
    const pnl = `${trade.pnlDollar >= 0 ? '+' : ''}${trade.pnlDollar.toFixed(2)}R (${(trade.pnlPct * 100).toFixed(2)}%)`;
    const context = [
      `Asset: ${asset}`,
      `Direction: ${dir}`,
      `Trade type: ${trade.signal.tradeType}`,
      `Strategy: ${trade.signal.strategy}`,
      `Setup score: ${trade.signal.score}/100 (${trade.signal.tier})`,
      `Regime: ${trade.signal.regime}`,
      `Entry: $${trade.entryPrice.toFixed(2)}`,
      `Exit: $${trade.exitPrice.toFixed(2)}`,
      `Result: ${pnl} (${(trade.pnlPct * 100).toFixed(2)}%)`,
      `Exit reason: ${trade.exitReason}`,
      `Notes: ${trade.signal.notes ?? 'none'}`,
    ].join('\n');

    const response = await callClaude(
      SYSTEM_PROMPT,
      `Please briefly explain this trade outcome and what the data suggests about why it performed this way:\n\n${context}`
    );

    return `🔍 **Trade Analysis**\n\n${response}`;
  } catch (err) {
    logger.error('Failed to explain trade:', err);
    return '🔍 Trade analysis unavailable — ANTHROPIC_API_KEY may not be set.';
  }
}

