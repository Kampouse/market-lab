// Debug script — prints pivot levels and breakout conditions

export const script = {
  name: 'pivot-debug',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    pivot_left:  { type: 'number', required: false, default: 3 },
    pivot_right: { type: 'number', required: false, default: 3 },
    min_spacing: { type: 'number', required: false, default: 0.002 },
    min_tests:   { type: 'number', required: false, default: 1 },
    ema_period:  { type: 'number', required: false, default: 20 },
  }
}

function ema(candles, period) {
  if (candles.length < period) return candles[candles.length - 1].c
  const k = 2 / (period + 1)
  let e = candles[candles.length - period].c
  for (let i = candles.length - period + 1; i < candles.length; i++) {
    e = candles[i].c * k + e * (1 - k)
  }
  return e
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
    if (isHigh) highs.push({ price: candles[i].h, bar: i })
    if (isLow)  lows.push({ price: candles[i].l, bar: i })
  }
  return { highs, lows }
}

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return
  const candles = history.source('candles@binance_futures')
  if (candles.length < 30) return

  const current = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const emaVal = ema(candles, ctx.params.ema_period)

  const pivots = findPivots(candles, ctx.params.pivot_left, ctx.params.pivot_right)

  const all = [
    ...pivots.highs.map(p => ({ ...p, type: 'R' })),
    ...pivots.lows.map(p => ({ ...p, type: 'S' }))
  ].sort((a, b) => a.price - b.price)

  const merged = []
  for (const lvl of all) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(lvl.price - last.price) / last.price < ctx.params.min_spacing) {
      last.tests++
    } else {
      merged.push({ ...lvl, tests: 1 })
    }
  }
  const levels = merged.filter(l => l.tests >= ctx.params.min_tests)

  // Check breakout conditions
  const resAbove = levels.filter(l => l.price > current.c && l.type === 'R').sort((a, b) => a.price - b.price)[0]
  const supBelow = levels.filter(l => l.price < current.c && l.type === 'S').sort((a, b) => b.price - a.price)[0]

  // Only log every 50 bars to avoid spam
  if (candles.length % 50 !== 0) return

  return {
    metrics: {
      bar: candles.length - 1,
      close: current.c,
      prev_close: prev.c,
      ema: Math.round(emaVal * 100) / 100,
      uptrend: current.c > emaVal,
      pivot_highs: pivots.highs.length,
      pivot_lows: pivots.lows.length,
      levels: levels.length,
      res_above: resAbove ? Math.round(resAbove.price) : null,
      sup_below: supBelow ? Math.round(supBelow.price) : null,
      bull_break: resAbove ? (current.c > resAbove.price && prev.c <= resAbove.price) : false,
      bear_break: supBelow ? (current.c < supBelow.price && prev.c >= supBelow.price) : false,
    }
  }
}