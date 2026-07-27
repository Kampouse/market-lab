// Pivot Hunter Pro v2 — Market Lab strategy
// Trades breakout retests with trend filter, volume confirmation, and ATR-based risk.

export const script = {
  name: 'pivot-hunter-v2',
  version: '1',
  sources: ['candles'],
  lookback: 300,
  params: {
    // Pivot detection
    pivot_left:   { type: 'number', required: false, default: 5 },
    pivot_right:  { type: 'number', required: false, default: 5 },
    min_spacing:  { type: 'number', required: false, default: 0.003 },
    min_tests:    { type: 'number', required: false, default: 1 },

    // Trend filter
    ema_period:   { type: 'number', required: false, default: 50 },  // EMA for trend direction

    // Volume confirmation
    vol_mult:     { type: 'number', required: false, default: 1.3 },
    lookback_vol: { type: 'number', required: false, default: 20 },

    // Risk management
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 1.5 },
    tp_rr:        { type: 'number', required: false, default: 2.0 },
    atr_period:   { type: 'number', required: false, default: 14 },

    // Cooldown
    cooldown_bars: { type: 'number', required: false, default: 5 }, // min bars between trades
  }
}

// --- Helpers ---

function ema(candles, period) {
  if (candles.length < period) return candles[candles.length - 1].c
  const k = 2 / (period + 1)
  let emaVal = candles[candles.length - period].c
  for (let i = candles.length - period + 1; i < candles.length; i++) {
    emaVal = candles[i].c * k + emaVal * (1 - k)
  }
  return emaVal
}

function sma(values, period) {
  if (values.length < period) return 0
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]
  return sum / period
}

function findPivots(candles, left, right) {
  const highs = []
  const lows = []
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].h > candles[i].h) isHigh = false
      if (candles[j].l < candles[i].l) isLow = false
    }
    if (isHigh) highs.push({ price: candles[i].h, bar: i })
    if (isLow)  lows.push({ price: candles[i].l, bar: i })
  }
  return { highs, lows }
}

function buildLevels(pivots, minSpacing, minTests) {
  const all = [
    ...pivots.highs.map(p => ({ ...p, type: 'resistance', tests: 1 })),
    ...pivots.lows.map(p => ({ ...p, type: 'support', tests: 1 }))
  ]
  all.sort((a, b) => a.price - b.price)

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
  if (candles.length < 60) return

  const current = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const currentBar = candles.length - 1

  // 1. Trend filter — only long above EMA, only short below
  const ema50 = ema(candles, ctx.params.ema_period)
  const uptrend = current.c > ema50
  const downtrend = current.c < ema50

  // 2. Pivots & levels
  const pivots = findPivots(candles, ctx.params.pivot_left, ctx.params.pivot_right)
  const levels = buildLevels(pivots, ctx.params.min_spacing, ctx.params.min_tests)
  if (levels.length === 0) return

  // 3. Volume
  const vols = candles.map(c => c.volume || c.vb || 0)
  const avgVol = sma(vols, ctx.params.lookback_vol)
  const currentVol = current.volume || current.vb || 0
  const volOK = avgVol > 0 && currentVol > avgVol * ctx.params.vol_mult

  // 4. ATR
  const atr = calcATR(candles, ctx.params.atr_period)
  if (atr <= 0) return

  // 5. Cooldown
  if (currentBar - lastTradeBar < ctx.params.cooldown_bars) return

  // 6. Find nearest levels
  const resAbove = levels.filter(l => l.price > current.c && l.type === 'resistance').sort((a, b) => a.price - b.price)[0]
  const supBelow = levels.filter(l => l.price < current.c && l.type === 'support').sort((a, b) => b.price - a.price)[0]

  // 7. Check open position
  const open = input.positions.open[0]

  // 8. Entry — breakout in trend direction
  if (!open) {
    // Long breakout: close breaks above resistance, in uptrend
    if (uptrend && resAbove && current.c > resAbove.price && prev.c <= resAbove.price && volOK) {
      const sl = current.c - atr * ctx.params.sl_atr_mult
      const risk = current.c - sl
      const tp = current.c + risk * ctx.params.tp_rr
      lastTradeBar = currentBar

      ctx.trade({
        key: `long-${current.t}`,
        position: 'open-long',
        margin: ctx.params.margin,
        order: { type: 'market' },
        leverage: ctx.params.leverage,
        sl, tp,
      })
      return { metrics: { signal: 'long_breakout', level: resAbove.price, close: current.c, ema: ema50, atr, vol: currentVol / avgVol } }
    }

    // Short breakout: close breaks below support, in downtrend
    if (downtrend && supBelow && current.c < supBelow.price && prev.c >= supBelow.price && volOK) {
      const sl = current.c + atr * ctx.params.sl_atr_mult
      const risk = sl - current.c
      const tp = current.c - risk * ctx.params.tp_rr
      lastTradeBar = currentBar

      ctx.trade({
        key: `short-${current.t}`,
        position: 'open-short',
        margin: ctx.params.margin,
        order: { type: 'market' },
        leverage: ctx.params.leverage,
        sl, tp,
      })
      return { metrics: { signal: 'short_breakout', level: supBelow.price, close: current.c, ema: ema50, atr, vol: currentVol / avgVol } }
    }
  }

  // 9. False breakout exit — close if price closes back through the level it broke
  if (open) {
    if (open.side === 'long' && resAbove && current.c < resAbove.price && prev.c < resAbove.price) {
      ctx.trade({ key: `exit-${current.t}`, position: 'close-long' })
      lastTradeBar = currentBar
      return { metrics: { signal: 'false_bo_long_exit', close: current.c, level: resAbove.price } }
    }
    if (open.side === 'short' && supBelow && current.c > supBelow.price && prev.c > supBelow.price) {
      ctx.trade({ key: `exit-${current.t}`, position: 'close-short' })
      lastTradeBar = currentBar
      return { metrics: { signal: 'false_bo_short_exit', close: current.c, level: supBelow.price } }
    }
  }

  return { metrics: { signal: 'none', close: current.c, ema: ema50, trend: uptrend ? 'up' : downtrend ? 'down' : 'flat', levels: levels.length } }
}