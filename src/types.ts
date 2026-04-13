export type Asset = string;
export type Timeframe = '1w' | '1d' | '4h' | '15m' | '5m' | '1m';
export type Direction = 'LONG' | 'SHORT';
export type Regime =
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'RANGE'
  | 'VOL_EXPANSION'
  | 'LOW_VOL_COMPRESSION'
  | 'POOR';
export type ScoreTier = 'NO_TRADE' | 'MEDIUM' | 'STRONG' | 'ELITE';
export type ExitReason = 'TP' | 'SL' | 'MANUAL' | 'CONDITION_CHANGE';

/**
 * SCALP  → SL < 0.3%, 5m/1m entry, hold < 1h,    high leverage (up to 75x)
 * HYBRID → SL 0.3-1.5%, 5m/15m, hold 1-4h,        medium leverage (up to 50x)
 * SWING  → SL 0.3-4%, 4h/Daily, hold 24-72 hours,  dynamic leverage (3% risk cap / stopPct, max 10x)
 *           Requires Weekly + Daily + 4h structural confluence.
 */
export type TradeType = 'SCALP' | 'HYBRID' | 'SWING';

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MultiTimeframeData {
  asset: Asset;
  '1w': OHLCV[];   // Weekly — HTF structural bias
  '1d': OHLCV[];   // Daily  — primary swing anchor
  '4h': OHLCV[];
  '15m': OHLCV[];
  '5m': OHLCV[];
  '1m'?: OHLCV[];
}

export interface ScoreComponents {
  htfAlignment: number;       // 0-20: higher timeframe trend alignment
  setupQuality: number;       // 0-20: quality of the pattern/setup
  momentum: number;           // 0-15: momentum confirmation
  volatilityQuality: number;  // 0-10: volatility is favourable for the setup
  regimeFit: number;          // 0-10: strategy fits the current regime
  liquidity: number;          // 0-10: sufficient volume/liquidity
  slippageRisk: number;       // 0-5:  low spread/slippage risk
  sessionQuality: number;     // 0-5:  good trading session (London/NY)
  recentPerformance: number;  // 0-5:  strategy recent win-rate contribution
}

export interface StrategySignal {
  id: string;
  strategy: string;
  asset: Asset;
  direction: Direction;
  tradeType: TradeType;
  entryZone: [number, number]; // [low, high]
  stopLoss: number;
  takeProfit: number;
  components: ScoreComponents;
  score: number;   // 0-100
  tier: ScoreTier;
  regime: Regime;
  timestamp: number;
  notes?: string;
  swingMeta?: SwingMeta;  // populated only for SWING trade type
}

export interface ActivePosition {
  id: string;
  signal: StrategySignal;
  entryPrice: number;
  suggestedLeverage: number;
  riskPct: number;
  confirmedAt: number;
  messageId: string;
  channelId: string;
  currentStopLoss: number;
  currentTakeProfit: number;
  highestPrice: number;
  lowestPrice: number;
  lastSLTPUpdateAt: number;
  tpExtensionCount: number;
  exitAlertSent: boolean;
  firedMilestones?: number[];
  /** @deprecated */
  lastProfitMilestonePct?: number;
  slProximityAlertAt?: number;
  lastHealthUpdatePrice?: number;
  lastHealthUpdateAt?: number;
}

export interface ClosedTrade extends ActivePosition {
  exitPrice: number;
  closedAt: number;
  pnlPct: number;
  pnlDollar: number;
  pnlR: number;      // R-multiple: pnl_pct / stop_distance_pct
  exitReason: ExitReason;
}

export interface PerformanceStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgScore: number;
  profitFactor: number;
  totalPnlDollar: number;
  byStrategy: Record<string, StrategyStats>;
  byTradeType: Record<string, { trades: number; wins: number; winRate: number }>;
}

export interface StrategyStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgScore: number;
}

export interface BotState {
  enabled: boolean;
  dailyLoss: number;
  dailyLossDate: string;
  strategyWeights: Record<string, number>;
  minScoreThreshold?: number;
}

export interface RegimeResult {
  asset: Asset;
  regime: Regime;
  adx: number;
  atrRatio: number;
  emaAligned: boolean;
  timestamp: number;
}

// ─── Swing trade types ────────────────────────────────────────────────────────

export type StructuralBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type SwingBiasConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Result of top-down market structure analysis across Weekly, Daily, 4h.
 * HIGH   = all 3 agree on HH/HL or LH/LL structure.
 * MEDIUM = Daily + 4h agree (Weekly neutral/insufficient data).
 * LOW    = no tradeable confluence — no swing signal fires.
 */
export interface SwingBias {
  direction: 'LONG' | 'SHORT' | null;
  confidence: SwingBiasConfidence;
  weeklyBias: StructuralBias;
  dailyBias: StructuralBias;
  fourHourBias: StructuralBias;
  agreementCount: number;
  notes: string;
}

/** A zone where multiple value criteria converge */
export interface AreaOfValue {
  priceHigh: number;
  priceLow: number;
  midpoint: number;
  confluenceScore: number;       // 0–4, one point per criterion met
  hasStructure: boolean;
  hasEmaConfluence: boolean;
  hasFibLevel: boolean;
  hasVolumeNode: boolean;
  nearestFibPct: number | null;
  notes: string;
}

export type SwingTrigger = 'DISPLACEMENT' | 'RSI_DIVERGENCE' | 'LIQUIDITY_SWEEP';

/** Swing-specific metadata attached to a StrategySignal */
export interface SwingMeta {
  bias: SwingBias;
  zone: AreaOfValue;
  trigger: SwingTrigger;
  triggerQuality: number;        // 0–15
  stopSwingPoint: number;
  primaryTP: number;
  extendedTP: number | null;
  rr: number;
  suggestedLeverage: number;     // dynamic: 3% risk cap / stopPct, hard cap 10x
  capitalAtRiskPct: number;      // stopPct × leverage (always ≤ 0.03)
}

// ─── Paper Trading Types ──────────────────────────────────────────────────────

export type PaperTradeStatus = 'pending' | 'active' | 'closed';
export type PaperCloseReason =
  | 'SL hit'
  | 'TP hit'
  | 'EMA breakdown'
  | 'manual'
  | 'max hold time'
  | 'pending expired';

/**
 * Rich indicator snapshot captured at the moment a paper trade is entered.
 * Used by the weekly analysis engine to find which conditions correlate with wins.
 */
export interface ScalpEntryMetadata {
  // Timing
  hourUTC: number;          // 0-23
  dayOfWeekUTC: number;     // 0=Sun, 6=Sat

  // 5m indicators at entry
  rsi5m: number;            // RSI(14)
  macdHist5m: number;       // MACD(5,13,3) histogram value
  macdCrossed5m: boolean;   // did MACD just cross?
  trend5m: string;          // 'UP' | 'DOWN' | 'NEUTRAL'

  // 1m indicators at entry
  rsi1m: number;
  atr1m: number;
  volumeRatio1m: number;    // last bar volume / 20-bar avg

  // 15m context
  trend15m: string;         // 'UP' | 'DOWN' | 'NEUTRAL'
  rsi15m: number;

  // FVG context
  hasFVG: boolean;          // was there an FVG at entry?
  fvgType: string;          // 'BULLISH' | 'BEARISH' | 'NONE'
  fvgStrength: number;      // gap size as % of price

  // Signal context
  signalScore: number;
  signalTier: string;
  regime: string;
  stopDistPct: number;      // SL distance from entry as decimal (e.g. 0.002 = 0.2%)
}

export interface PaperTrade {
  id: string;
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizeDollars: number;  // risk amount in dollars (what we're willing to lose on SL)
  leverage: number;
  strategy: string;
  tradeType: string;
  status: PaperTradeStatus;
  openTime: string;      // ISO string
  closeTime?: string;
  exitPrice?: number;
  pnlDollar?: number;
  pnlR?: number;
  pnlPct?: number;       // raw price move % (pre-leverage)
  holdMinutes?: number;  // how long the trade was open
  closeReason?: PaperCloseReason;
  balanceAfter?: number;
  meta?: ScalpEntryMetadata;  // rich snapshot captured at entry for analysis

  // Pending order fields (scalp limit orders)
  pendingEntryPrice?: number;   // limit price to wait for (SCALP only)
  pendingExpiresAt?: string;    // ISO string — cancel if not filled by this time
}

export interface PaperState {
  virtualBalance: number;
  startingBalance: number;
  lastUpdated: string;
  consecutiveLosses?: number;    // running count of consecutive losses
  circuitBreakerUntil?: string;  // ISO string — skip new entries until this time
  blownAt?: string;              // ISO string — set when balance drops below minimum; cleared on reset
}
