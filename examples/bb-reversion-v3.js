// BB Reversion Scalp v3 — Dynamic Risk Agent
// Mean-reversion with ADX filter + adaptive risk management.
// Since the framework doesn't expose closed trade PnLs, we track
// entries internally and detect exits by watching when open positions disappear.
// We estimate PnL from entry price vs current price at exit time.

export const script = {
  name: 'bb-reversion-v3',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    // Bollinger Bands
    bb_period:    { type: 'number', required: false, default: 20 },
    bb_std:       { type: 'number', required: false, default: 3.5 },
    min_band_pct: { type: 'number', required: false, default: 0.1 },

    // ADX trend filter
    adx_period:   { type: 'number', required: false, default: 14 },
    adx_max:      { type: 'number', required: false, default: 50 },

    // Volume
    vol_mult:     { type: 'number', required: false, default: 1.0 },
    lookback_vol: { type: 'number', required: false, default: 10 },

    // Risk
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 2.0 },
    atr_period:   { type: 'number', required: false, default: 14 },

    // Min distance from midline
    min_dist_pct: { type: 'number', required: false, default: 0.3 },

    // === DYNAMIC RISK AGENT ===
    // After N consecutive losses: pause for X bars
    max_consec_losses: { type: 'number', required: false, default: 3 },
    loss_cooldown_bars: { type: 'number', required: false, default: 20 },

    // After N losses in same direction: block that direction for X bars
    max_dir_losses: { type: 'number', required: false, default: 2 },
    dir_block_bars: { type: 'number', required: false, default: 15 },

    // Position sizing — scale down after losses, up after wins
    loss_size_factor: { type: 'number', required: false, default: 0.5 },
    win_size_factor: { type: 'number', required: false, default: 1.5 },
    min_margin_pct: { type: 'number', required: false, default: 0.25 },

    // Rolling window for win rate assessment
    recent_trades_window: { type: 'number', required: false, default: 5 },
    low_winrate_adx_tighten: { type: 'number', required: false, default: 40 },
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

function calcADX(candles, period) {
  if (candles.length < period * 2 + 1) return 0
  const len = candles.length
  const dmPlusArr = [], dmMinusArr = [], trArr = []
  for (let i = len - period * 2; i < len; i++) {
    const up = candles[i].h - candles[i - 1].h
    const down = candles[i - 1].l - candles[i].l
    let dp = 0, dm = 0
    if (up > down && up > 0) dp = up
    if (down > up && down > 0) dm = down
    const t = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    )
    dmPlusArr.push(dp)
    dmMinusArr.push(dm)
    trArr.push(t)
  }
  let smaTR = smaArr(trArr, period)
  let smaDP = smaArr(dmPlusArr, period)
  let smaDM = smaArr(dmMinusArr, period)
  if (smaTR === 0) return 0
  let diPlus = (smaDP / smaTR) * 100
  let diMinus = (smaDM / smaTR) * 100
  const dx = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100
  return dx
}

// --- State ---
let lastTradeBar = -999

// === DYNAMIC RISK AGENT STATE ===
const tradeHistory = []  // {side, pnl, bar, win}
let consecLosses = 0
let consecLossesLong = 0
let consecLossesShort = 0
let cooldownUntilBar = -999
let longBlockedUntil = -999
let shortBlockedUntil = -999
let currentMarginScale = 1.0

// Track our open position internally (since framework doesn't expose closed PnLs)
let myOpenPosition = null  // {side, entryPrice, sl, tp, margin, key, entryBar}
let wasOpen = false

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 50) return

  const idx = candles.length - 1
  const current = candles[idx]
  const prev = candles[idx - 1]
  if (!prev) return

  const open = input.positions.open[0]

  // === RISK AGENT: Detect trade closure ===
  // We had a position, now we don't — figure out if it was a win or loss
  if (wasOpen && !open && myOpenPosition) {
    const pos = myOpenPosition
    // Estimate PnL: for long, exit - entry; for short, entry - exit
    // We don't know the exact exit price, but we can infer from SL/TP:
    // If current price is near or beyond TP → win
    // If current price is near or beyond SL → loss
    let win = false
    let estPnl = 0
    if (pos.side === 'long') {
      // If price dropped to near SL, it's a loss
      if (current.c <= pos.sl * 1.001) {
        win = false
        estPnl = current.c - pos.entryPrice
      } else {
        win = true
        estPnl = (pos.tp - pos.entryPrice) // approximate
      }
    } else {
      if (current.c >= pos.sl * 0.999) {
        win = false
        estPnl = pos.entryPrice - current.c
      } else {
        win = true
        estPnl = (pos.entryPrice - pos.tp)
      }
    }

    // More accurate: use actual close price
    const exitPrice = current.c
    if (pos.side === 'long') {
      estPnl = (exitPrice - pos.entryPrice) / pos.entryPrice * pos.margin * ctx.params.leverage
    } else {
      estPnl = (pos.entryPrice - exitPrice) / pos.entryPrice * pos.margin * ctx.params.leverage
    }

    tradeHistory.push({ side: pos.side, pnl: estPnl, bar: idx, win })
    if (tradeHistory.length > 20) tradeHistory.shift()

    if (win) {
      consecLosses = 0
      if (pos.side === 'long') consecLossesLong = 0
      else consecLossesShort = 0
      currentMarginScale = Math.min(1.0, currentMarginScale * ctx.params.win_size_factor)
    } else {
      consecLosses++
      if (pos.side === 'long') consecLossesLong++
      else consecLossesShort++
      currentMarginScale = Math.max(ctx.params.min_margin_pct, currentMarginScale * ctx.params.loss_size_factor)

      if (consecLosses >= ctx.params.max_consec_losses) {
        cooldownUntilBar = idx + ctx.params.loss_cooldown_bars
      }
      if (pos.side === 'long' && consecLossesLong >= ctx.params.max_dir_losses) {
        longBlockedUntil = idx + ctx.params.dir_block_bars
      }
      if (pos.side === 'short' && consecLossesShort >= ctx.params.max_dir_losses) {
        shortBlockedUntil = idx + ctx.params.dir_block_bars
      }
    }

    myOpenPosition = null
  }
  wasOpen = !!open

  // 1. Bollinger Bands
  const period = ctx.params.bb_period
  const mid = sma(candles, period)
  const sd = stddev(candles, period, mid)
  const upper = mid + sd * ctx.params.bb_std
  const lower = mid - sd * ctx.params.bb_std
  const bandWidth = (upper - lower) / mid * 100
  if (bandWidth < ctx.params.min_band_pct) return

  // 2. ADX — dynamic threshold
  const adx = calcADX(candles, ctx.params.adx_period)
  let effectiveAdxMax = ctx.params.adx_max
  if (tradeHistory.length >= ctx.params.recent_trades_window) {
    const recent = tradeHistory.slice(-ctx.params.recent_trades_window)
    const wins = recent.filter(t => t.win).length
    const winRate = wins / recent.length
    if (winRate < 0.5) {
      effectiveAdxMax = ctx.params.low_winrate_adx_tighten
    }
  }
  if (adx > effectiveAdxMax) return

  // 3. ATR
  const atr = calcATR(candles, ctx.params.atr_period)
  if (atr <= 0) return

  // 4. Volume
  const vols = candles.map(c => c.volume || c.vb || 0)
  const avgVol = smaArr(vols, ctx.params.lookback_vol)
  const currentVol = current.volume || current.vb || 0
  const volOK = avgVol > 0 && currentVol >= avgVol * ctx.params.vol_mult

  // 5. Cooldown check
  if (idx < cooldownUntilBar) {
    return { metrics: { signal: 'cooldown', close: current.c, consecLosses, barsLeft: cooldownUntilBar - idx, scale: currentMarginScale.toFixed(2) } }
  }

  // 6. Entry
  if (!open && volOK) {
    const distPct = Math.abs(current.c - mid) / current.c * 100

    // Long
    if (current.l <= lower && distPct >= ctx.params.min_dist_pct && idx >= longBlockedUntil) {
      const sl = current.c - atr * ctx.params.sl_atr_mult
      const tp = Math.max(mid, current.c + 0.001)
      lastTradeBar = idx
      const tradeMargin = ctx.params.margin * currentMarginScale
      myOpenPosition = { side: 'long', entryPrice: current.c, sl, tp, margin: tradeMargin, entryBar: idx }
      wasOpen = true
      ctx.trade({
        key: `l-${current.t}`, position: 'open-long',
        margin: tradeMargin, order: { type: 'market' },
        leverage: ctx.params.leverage, sl, tp,
      })
      return { metrics: { signal: 'long', close: current.c, lower: lower.toFixed(4), mid: mid.toFixed(4), adx: adx.toFixed(1), bw: bandWidth.toFixed(2), dist: distPct.toFixed(2), scale: currentMarginScale.toFixed(2), consecLosses, consecL: consecLossesLong, consecS: consecLossesShort } }
    }
    // Short
    if (current.h >= upper && distPct >= ctx.params.min_dist_pct && idx >= shortBlockedUntil) {
      const sl = current.c + atr * ctx.params.sl_atr_mult
      const tp = Math.min(mid, current.c - 0.001)
      lastTradeBar = idx
      const tradeMargin = ctx.params.margin * currentMarginScale
      myOpenPosition = { side: 'short', entryPrice: current.c, sl, tp, margin: tradeMargin, entryBar: idx }
      wasOpen = true
      ctx.trade({
        key: `s-${current.t}`, position: 'open-short',
        margin: tradeMargin, order: { type: 'market' },
        leverage: ctx.params.leverage, sl, tp,
      })
      return { metrics: { signal: 'short', close: current.c, upper: upper.toFixed(4), mid: mid.toFixed(4), adx: adx.toFixed(1), bw: bandWidth.toFixed(2), dist: distPct.toFixed(2), scale: currentMarginScale.toFixed(2), consecLosses, consecL: consecLossesLong, consecS: consecLossesShort } }
    }
  }

  if (!open) lastTradeBar = idx
  return { metrics: { signal: 'none', close: current.c, adx: adx.toFixed(1), bw: bandWidth.toFixed(2), consecLosses, scale: currentMarginScale.toFixed(2) } }
}