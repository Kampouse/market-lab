// Pivot Hunter Pro v3 — Market Lab strategy
// Tracks S/R levels and trades when price crosses them with trend + volume confirmation.

export const script = {
  name: 'pivot-hunter-v3',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    pivot_left:   { type: 'number', required: false, default: 5 },
    pivot_right:  { type: 'number', required: false, default: 5 },
    min_spacing:  { type: 'number', required: false, default: 0.003 },
    min_tests:    { type: 'number', required: false, default: 1 },
    ema_period:   { type: 'number', required: false, default: 20 },
    vol_mult:     { type: 'number', required: false, default: 1.0 },
    lookback_vol: { type: 'number', required: false, default: 20 },
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 1.5 },
    tp_rr:        { type: 'number', required: false, default: 2.0 },
    atr_period:   { type: 'number', required: false, default: 14 },
    cooldown_bars: { type: 'number', required: false, default: 3 },
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
  // Only look at pivots that are confirmed (i.e., at least `right` bars ago)
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

// --- Strategy ---

let lastTradeBar = -999

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 30) return

  const idx = candles.length - 1
  const current = candles[idx]
  const prev = candles[idx - 1]
  if (!prev) return

  // 1. Trend filter
  const emaVal = ema(candles, ctx.params.ema_period)
  const uptrend = current.c > emaVal
  const downtrend = current.c < emaVal

  // 2. Pivots & levels (only confirmed pivots)
  const pivots = findPivots(candles, ctx.params.pivot_left, ctx.params.pivot_right)
  const levels = buildLevels(pivots, ctx.params.min_spacing, ctx.params.min_tests)

  // 3. Volume
  const vols = candles.map(c => c.volume || c.vb || 0)
  const avgVol = smaArr(vols, ctx.params.lookback_vol)
  const currentVol = current.volume || current.vb || 0
  const volOK = avgVol > 0 && currentVol >= avgVol * ctx.params.vol_mult

  // 4. ATR
  const atr = calcATR(candles, ctx.params.atr_period)
  if (atr <= 0) return

  // 5. Cooldown
  if (idx - lastTradeBar < ctx.params.cooldown_bars) return

  // 6. Find levels near current price (within 0.5% above/below)
  const nearHigh = 0.005
  const resNear = levels
    .filter(l => l.type === 'resistance' && l.price > current.c * (1 - nearHigh) && l.price < current.c * (1 + nearHigh))
    .sort((a, b) => a.price - b.price)
  const supNear = levels
    .filter(l => l.type === 'support' && l.price < current.c * (1 + nearHigh) && l.price > current.c * (1 - nearHigh))
    .sort((a, b) => b.price - a.price)

  // 7. Check open position
  const open = input.positions.open[0]

  // 8. Entry — price crosses a level
  if (!open) {
    // Long: prev close was below a resistance, current close is above it
    for (const lvl of resNear) {
      if (prev.c < lvl.price && current.c > lvl.price && uptrend && volOK) {
        const sl = current.c - atr * ctx.params.sl_atr_mult
        const tp = current.c + (current.c - sl) * ctx.params.tp_rr
        lastTradeBar = idx
        ctx.trade({
          key: `long-${current.t}`,
          position: 'open-long',
          margin: ctx.params.margin,
          order: { type: 'market' },
          leverage: ctx.params.leverage,
          sl, tp,
        })
        return { metrics: { signal: 'long_breakout', level: lvl.price, close: current.c, ema: Math.round(emaVal), atr: Math.round(atr), vol: Math.round(currentVol / avgVol * 100) / 100 } }
      }
    }

    // Short: prev close was above a support, current close is below it
    for (const lvl of supNear) {
      if (prev.c > lvl.price && current.c < lvl.price && downtrend && volOK) {
        const sl = current.c + atr * ctx.params.sl_atr_mult
        const tp = current.c - (sl - current.c) * ctx.params.tp_rr
        lastTradeBar = idx
        ctx.trade({
          key: `short-${current.t}`,
          position: 'open-short',
          margin: ctx.params.margin,
          order: { type: 'market' },
          leverage: ctx.params.leverage,
          sl, tp,
        })
        return { metrics: { signal: 'short_breakout', level: lvl.price, close: current.c, ema: Math.round(emaVal), atr: Math.round(atr), vol: Math.round(currentVol / avgVol * 100) / 100 } }
      }
    }
  }

  // 9. False breakout exit
  if (open) {
    if (open.side === 'long') {
      // Close if we fall back below a support level
      for (const lvl of supNear) {
        if (prev.c > lvl.price && current.c < lvl.price) {
          ctx.trade({ key: `exit-${current.t}`, position: 'close-long' })
          lastTradeBar = idx
          return { metrics: { signal: 'false_bo_long', close: current.c, level: lvl.price } }
        }
      }
    }
    if (open.side === 'short') {
      for (const lvl of resNear) {
        if (prev.c < lvl.price && current.c > lvl.price) {
          ctx.trade({ key: `exit-${current.t}`, position: 'close-short' })
          lastTradeBar = idx
          return { metrics: { signal: 'false_bo_short', close: current.c, level: lvl.price } }
        }
      }
    }
  }

  return { metrics: { signal: 'none', close: current.c, ema: Math.round(emaVal), trend: uptrend ? 'up' : downtrend ? 'down' : 'flat', levels: levels.length, res_near: resNear.length, sup_near: supNear.length } }
}