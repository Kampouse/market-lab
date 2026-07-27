// Pivot Hunter Pro v5 — Market Lab scalping strategy
// v5: ADX regime filter — skip choppy markets, only trade when there's a real trend.

export const script = {
  name: 'pivot-hunter-v5',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    pivot_left:   { type: 'number', required: false, default: 3 },
    pivot_right:  { type: 'number', required: false, default: 3 },
    min_spacing:  { type: 'number', required: false, default: 0.002 },
    min_tests:   { type: 'number', required: false, default: 1 },

    // Dual EMA trend filter
    ema_fast:     { type: 'number', required: false, default: 9 },
    ema_slow:     { type: 'number', required: false, default: 21 },

    // ADX regime filter — must be above this to trade
    adx_period:   { type: 'number', required: false, default: 14 },
    adx_min:      { type: 'number', required: false, default: 20 }, // below 20 = chop, skip

    // ATR volatility filter — skip if ATR/price below this (dead market)
    min_atr_pct:  { type: 'number', required: false, default: 0.003 }, // 0.3% — skip if lower

    // Volume confirmation
    vol_mult:     { type: 'number', required: false, default: 1.3 },
    lookback_vol: { type: 'number', required: false, default: 20 },

    // Risk management
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 1.5 },
    tp_rr:        { type: 'number', required: false, default: 1.5 },
    atr_period:   { type: 'number', required: false, default: 14 },

    // Cooldown
    cooldown_bars: { type: 'number', required: false, default: 2 },

    // False breakout exit
    false_bo_bars: { type: 'number', required: false, default: 3 },
  }
}

// --- Helpers ---

function ema(candles, period) {
  if (candles.length < period) return candles[candles.length - 1].c
  const k = 2 / (period + 1)
  let e = candles[candles.length - period].c
  for (let i = candles.length - period + 1; i < candles.length; i++) {
    e = candles[i].c * k + e * (1 - k)
  }
  return e
}

function smaArr(values, period) {
  if (values.length < period) return 0
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]
  return sum / period
}

function findPivots(candles, left, right) {
  const highs = [], lows = []
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].h > candles[i].h) isHigh = false
      if (candles[j].l < candles[i].l) isLow = false
    }
    if (isHigh) highs.push({ price: candles[i].h, bar: i, t: candles[i].t })
    if (isLow)  lows.push({ price: candles[i].l, bar: i, t: candles[i].t })
  }
  return { highs, lows }
}

function buildLevels(pivots, minSpacing, minTests) {
  const all = [
    ...pivots.highs.map(p => ({ ...p, type: 'resistance', tests: 1 })),
    ...pivots.lows.map(p => ({ ...p, type: 'support', tests: 1 }))
  ].sort((a, b) => a.price - b.price)
  const merged = []
  for (const lvl of all) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(lvl.price - last.price) / last.price < minSpacing) {
      last.price = (last.price * last.tests + lvl.price) / (last.tests + 1)
      last.tests++
      last.bar = Math.max(last.bar, lvl.bar)
    } else {
      merged.push({ ...lvl })
    }
  }
  return merged.filter(l => l.tests >= minTests)
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    )
    sum += tr
  }
  return sum / period
}

// ADX — trend strength indicator
function calcADX(candles, period) {
  if (candles.length < period * 2 + 1) return 0

  const len = candles.length
  let plusDM = [], minusDM = [], trs = []

  for (let i = len - period * 2; i < len; i++) {
    const up = candles[i].h - candles[i - 1].h
    const down = candles[i - 1].l - candles[i].l
    let pdm = 0, mdm = 0
    if (up > down && up > 0) pdm = up
    if (down > up && down > 0) mdm = down
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    )
    plusDM.push(pdm)
    minusDM.push(mdm)
    trs.push(tr)
  }

  // Wilder's smoothing
  let atr = smaArr(trs, period)
  if (atr <= 0) return 0

  let plusDI = 0, minusDI = 0
  for (let i = 0; i < period; i++) {
    plusDI += plusDM[i + period]
    minusDI += minusDM[i + period]
  }
  plusDI = (plusDI / period / atr) * 100
  minusDI = (minusDI / period / atr) * 100

  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100
  if (!isFinite(dx) || isNaN(dx)) return 0
  return dx
}

// --- Strategy ---

let lastTradeBar = -999
let entryInfo = null

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 40) return

  const idx = candles.length - 1
  const current = candles[idx]
  const prev = candles[idx - 1]
  if (!prev) return

  // 1. Dual EMA trend filter
  const emaF = ema(candles, ctx.params.ema_fast)
  const emaS = ema(candles, ctx.params.ema_slow)
  const uptrend = emaF > emaS
  const downtrend = emaF < emaS

  // 2. ADX regime filter — skip chop
  const adx = calcADX(candles, ctx.params.adx_period)
  const trending = adx >= ctx.params.adx_min

  // 3. Pivots & levels
  const pivots = findPivots(candles, ctx.params.pivot_left, ctx.params.pivot_right)
  const levels = buildLevels(pivots, ctx.params.min_spacing, ctx.params.min_tests)

  // 4. Volume
  const vols = candles.map(c => c.volume || c.vb || 0)
  const avgVol = smaArr(vols, ctx.params.lookback_vol)
  const currentVol = current.volume || current.vb || 0
  const volOK = avgVol > 0 && currentVol >= avgVol * ctx.params.vol_mult

  // 5. ATR
  const atr = calcATR(candles, ctx.params.atr_period)
  if (atr <= 0) return

  // 6. Cooldown
  if (idx - lastTradeBar < ctx.params.cooldown_bars) return

  // 7. Find levels near price
  const near = 0.005
  const resNear = levels
    .filter(l => l.type === 'resistance' && l.price > current.c * (1 - near) && l.price < current.c * (1 + near))
    .sort((a, b) => a.price - b.price)
  const supNear = levels
    .filter(l => l.type === 'support' && l.price < current.c * (1 + near) && l.price > current.c * (1 - near))
    .sort((a, b) => b.price - a.price)

  // 8. Check open position
  const open = input.positions.open[0]

  // 9. Entry — only if trending (ADX > threshold) and enough volatility
  if (!open) {
    entryInfo = null

    const atrPct = atr / current.c
    const volEnough = atrPct >= ctx.params.min_atr_pct

    if (trending && volOK && volEnough) {
      // Long: close crosses above resistance, uptrend
      for (const lvl of resNear) {
        if (prev.c < lvl.price && current.c > lvl.price && uptrend) {
          const sl = current.c - atr * ctx.params.sl_atr_mult
          const tp = current.c + (current.c - sl) * ctx.params.tp_rr
          lastTradeBar = idx
          entryInfo = { side: 'long', level: lvl.price, entryBar: idx, entryPrice: current.c }
          ctx.trade({
            key: `long-${current.t}`, position: 'open-long',
            margin: ctx.params.margin, order: { type: 'market' },
            leverage: ctx.params.leverage, sl, tp,
          })
          return { metrics: { signal: 'long_breakout', level: lvl.price, close: current.c, adx: Math.round(adx), atr: Math.round(atr), vol: Math.round(currentVol / avgVol * 100) / 100 } }
        }
      }

      // Short: close crosses below support, downtrend
      for (const lvl of supNear) {
        if (prev.c > lvl.price && current.c < lvl.price && downtrend) {
          const sl = current.c + atr * ctx.params.sl_atr_mult
          const tp = current.c - (sl - current.c) * ctx.params.tp_rr
          lastTradeBar = idx
          entryInfo = { side: 'short', level: lvl.price, entryBar: idx, entryPrice: current.c }
          ctx.trade({
            key: `short-${current.t}`, position: 'open-short',
            margin: ctx.params.margin, order: { type: 'market' },
            leverage: ctx.params.leverage, sl, tp,
          })
          return { metrics: { signal: 'short_breakout', level: lvl.price, close: current.c, adx: Math.round(adx), atr: Math.round(atr), vol: Math.round(currentVol / avgVol * 100) / 100 } }
        }
      }
    }
  }

  // 10. False breakout exit
  if (open && entryInfo) {
    const barsSince = idx - entryInfo.entryBar
    if (barsSince <= ctx.params.false_bo_bars) {
      if (entryInfo.side === 'long' && current.c < entryInfo.level && prev.c < entryInfo.level) {
        ctx.trade({ key: `exit-${current.t}`, position: 'close-long' })
        lastTradeBar = idx
        const lv = entryInfo.level
        entryInfo = null
        return { metrics: { signal: 'false_bo_long', close: current.c, level: lv } }
      }
      if (entryInfo.side === 'short' && current.c > entryInfo.level && prev.c > entryInfo.level) {
        ctx.trade({ key: `exit-${current.t}`, position: 'close-short' })
        lastTradeBar = idx
        const lv = entryInfo.level
        entryInfo = null
        return { metrics: { signal: 'false_bo_short', close: current.c, level: lv } }
      }
    }
  }

  if (!open) entryInfo = null

  return { metrics: { signal: 'none', close: current.c, adx: Math.round(adx), trending, trend: uptrend ? 'up' : downtrend ? 'down' : 'flat', levels: levels.length } }
}