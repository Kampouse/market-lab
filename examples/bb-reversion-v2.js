// BB Reversion Scalp v2 — for NEAR/USDT
// Mean-reversion with ADX trend filter: only trade when market is range-bound (ADX < threshold).
// Exits at Bollinger midline. Stops on ATR.

export const script = {
  name: 'bb-reversion-v2',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    // Bollinger Bands
    bb_period:    { type: 'number', required: false, default: 20 },
    bb_std:       { type: 'number', required: false, default: 3.5 },

    // Band width filter
    min_band_pct: { type: 'number', required: false, default: 0.1 },

    // ADX trend filter — skip trades when ADX > threshold (strong trend)
    adx_period:   { type: 'number', required: false, default: 14 },
    adx_max:      { type: 'number', required: false, default: 25 }, // only trade if ADX < 25

    // Volume
    vol_mult:     { type: 'number', required: false, default: 1.0 },
    lookback_vol: { type: 'number', required: false, default: 10 },

    // Risk
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 2.5 },
    atr_period:   { type: 'number', required: false, default: 14 },

    // Exit at midline
    exit_midline: { type: 'number', required: false, default: 1 },

    // Cooldown
    cooldown_bars: { type: 'number', required: false, default: 0 },

    // Min distance from midline as % of price — skip if too close to midline
    min_dist_pct: { type: 'number', required: false, default: 0.3 },
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

// ADX calculation
function calcADX(candles, period) {
  if (candles.length < period * 2 + 1) return 0
  const len = candles.length
  let dmPlus = 0, dmMinus = 0, tr = 0
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
  // Smooth using Wilder's method
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

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 50) return

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
  const bandWidth = (upper - lower) / mid * 100

  if (bandWidth < ctx.params.min_band_pct) return

  // 2. ADX — skip if trending
  const adx = calcADX(candles, ctx.params.adx_period)
  if (adx > ctx.params.adx_max) return

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

  // 6. Check open position
  const open = input.positions.open[0]

  // 7. Entry — touch band, exit at midline
  if (!open) {
    if (volOK) {
      // Long — price pierced lower band AND far enough from midline
      if (current.l <= lower) {
        const distPct = Math.abs(current.c - mid) / current.c * 100
        if (distPct >= ctx.params.min_dist_pct) {
        const sl = current.c - atr * ctx.params.sl_atr_mult
        const tp = ctx.params.exit_midline ? Math.max(mid, current.c + 0.001) : current.c + (current.c - sl)
        lastTradeBar = idx
        ctx.trade({
          key: `l-${current.t}`, position: 'open-long',
          margin: ctx.params.margin, order: { type: 'market' },
          leverage: ctx.params.leverage, sl, tp,
        })
        return { metrics: { signal: 'long', close: current.c, lower: lower.toFixed(4), mid: mid.toFixed(4), adx: adx.toFixed(1), bw: bandWidth.toFixed(2), dist: distPct.toFixed(2) } }
        }
      }
      // Short — price pierced upper band AND far enough from midline
      if (current.h >= upper) {
        const distPct = Math.abs(current.c - mid) / current.c * 100
        if (distPct >= ctx.params.min_dist_pct) {
        const sl = current.c + atr * ctx.params.sl_atr_mult
        const tp = ctx.params.exit_midline ? Math.min(mid, current.c - 0.001) : current.c - (sl - current.c)
        lastTradeBar = idx
        ctx.trade({
          key: `s-${current.t}`, position: 'open-short',
          margin: ctx.params.margin, order: { type: 'market' },
          leverage: ctx.params.leverage, sl, tp,
        })
        return { metrics: { signal: 'short', close: current.c, upper: upper.toFixed(4), mid: mid.toFixed(4), adx: adx.toFixed(1), bw: bandWidth.toFixed(2), dist: distPct.toFixed(2) } }
        }
      }
    }
  }

  if (!open) lastTradeBar = idx
  return { metrics: { signal: 'none', close: current.c, adx: adx.toFixed(1), bw: bandWidth.toFixed(2) } }
}