// BB Reversion Scalp — for NEAR/USDT
// Mean-reversion: Bollinger Band touch + reversal candle, exits at midline.
// For BTC-correlated choppy assets that bounce between bands.

export const script = {
  name: 'bb-reversion',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    // Bollinger Bands
    bb_period:    { type: 'number', required: false, default: 20 },
    bb_std:       { type: 'number', required: false, default: 2.0 },

    // Band width filter — only trade when bands are wide enough (not squeeze)
    min_band_pct: { type: 'number', required: false, default: 0.3 }, // min band width as % of price

    // Reversal candle confirmation
    require_reversal: { type: 'number', required: false, default: 1 }, // 1=need reversal candle

    // Volume
    vol_mult:     { type: 'number', required: false, default: 1.0 },
    lookback_vol: { type: 'number', required: false, default: 10 },

    // Risk
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 1.0 },
    tp_rr:        { type: 'number', required: false, default: 1.0 },
    atr_period:   { type: 'number', required: false, default: 14 },

    // Exit at midline (SMA) — if true, ignore TP and exit when price crosses mid
    exit_midline: { type: 'number', required: false, default: 1 },

    // Cooldown
    cooldown_bars: { type: 'number', required: false, default: 2 },
  }
}

// --- Helpers ---

function sma(candles, period) {
  if (candles.length < period) return candles[candles.length - 1].c
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) sum += candles[i].c
  return sum / period
}

function stddev(candles, period, mean) {
  if (candles.length < period) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.pow(candles[i].c - mean, 2)
  }
  return Math.sqrt(sum / period)
}

function smaArr(values, period) {
  if (values.length < period) return 0
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]
  return sum / period
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    )
  }
  return sum / period
}

// --- State ---
let lastTradeBar = -999

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 30) return

  const idx = candles.length - 1
  const current = candles[idx]
  const prev = candles[idx - 1]
  if (!prev) return

  // 1. Bollinger Bands
  const period = ctx.params.bb_period
  const mid = sma(candles, period)
  const sd = stddev(candles, period, mid)
  const upper = mid + sd * ctx.params.bb_std
  const lower = mid - sd * ctx.params.bb_std
  const bandWidth = (upper - lower) / mid * 100 // as % of price

  // 2. Band width filter
  if (bandWidth < ctx.params.min_band_pct) return

  // 3. ATR
  const atr = calcATR(candles, ctx.params.atr_period)
  if (atr <= 0) return

  // 4. Volume
  const vols = candles.map(c => c.volume || c.vb || 0)
  const avgVol = smaArr(vols, ctx.params.lookback_vol)
  const currentVol = current.volume || current.vb || 0
  const volOK = avgVol > 0 && currentVol >= avgVol * ctx.params.vol_mult

  // 5. Cooldown
  if (ctx.params.cooldown_bars > 0 && idx - lastTradeBar < ctx.params.cooldown_bars) return

  // 6. Reversal candle check
  // For long: prev closed below lower, current closes above lower (rejection)
  // For short: prev closed above upper, current closes below upper
  const reversalLong = ctx.params.require_reversal === 0 ||
    (prev.c < lower && current.c > lower && current.c > current.o) // bullish reversal
  const reversalShort = ctx.params.require_reversal === 0 ||
    (prev.c > upper && current.c < upper && current.c < current.o) // bearish reversal

  // 7. Check open position
  const open = input.positions.open[0]

  // 8. Entry
  if (!open) {
    if (volOK) {
      // Long — price touched/pierced lower band and reversed
      if (current.l <= lower && reversalLong) {
        const sl = current.c - atr * ctx.params.sl_atr_mult
        const tpDist = (current.c - sl) * ctx.params.tp_rr
        const tp = ctx.params.exit_midline ? Math.max(mid, current.c + 0.001) : current.c + tpDist
        lastTradeBar = idx
        ctx.trade({
          key: `l-${current.t}`, position: 'open-long',
          margin: ctx.params.margin, order: { type: 'market' },
          leverage: ctx.params.leverage, sl, tp,
        })
        return { metrics: { signal: 'long', close: current.c, lower: lower.toFixed(4), mid: mid.toFixed(4), bw: bandWidth.toFixed(2) } }
      }
      // Short — price touched/pierced upper band and reversed
      if (current.h >= upper && reversalShort) {
        const sl = current.c + atr * ctx.params.sl_atr_mult
        const tpDist = (sl - current.c) * ctx.params.tp_rr
        const tp = ctx.params.exit_midline ? Math.min(mid, current.c - 0.001) : current.c - tpDist
        lastTradeBar = idx
        ctx.trade({
          key: `s-${current.t}`, position: 'open-short',
          margin: ctx.params.margin, order: { type: 'market' },
          leverage: ctx.params.leverage, sl, tp,
        })
        return { metrics: { signal: 'short', close: current.c, upper: upper.toFixed(4), mid: mid.toFixed(4), bw: bandWidth.toFixed(2) } }
      }
    }
  }

  // 9. Midline exit — if price crosses mid, close
  if (open && ctx.params.exit_midline) {
    // We can't close manually in this framework easily, but TP=mid should handle it
    // The TP is set to mid at entry, so it should trigger automatically
  }

  if (!open) lastTradeBar = idx
  return { metrics: { signal: 'none', close: current.c, mid: mid.toFixed(4), bw: bandWidth.toFixed(2) } }
}