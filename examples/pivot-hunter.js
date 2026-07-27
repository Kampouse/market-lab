// Pivot Hunter Pro — Market Lab strategy
// Detects pivot-based S/R levels, trades breakouts with volume confirmation,
// filters false breakouts, and manages risk with SL/TP.

export const script = {
  name: 'pivot-hunter',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    // Pivot detection
    pivot_left:   { type: 'number', required: false, default: 5 },   // bars left of pivot
    pivot_right:  { type: 'number', required: false, default: 5 },   // bars right of pivot
    min_spacing:  { type: 'number', required: false, default: 0.002 }, // min distance between levels (0.2%)
    min_tests:    { type: 'number', required: false, default: 2 },  // min times a level must be tested

    // Breakout confirmation
    vol_mult:     { type: 'number', required: false, default: 1.5 }, // volume must be > vol_mult * avg volume
    lookback_vol: { type: 'number', required: false, default: 20 },  // bars for avg volume calc

    // False breakout filter
    false_breakout_bars: { type: 'number', required: false, default: 3 }, // bars to confirm close back through

    // Risk management
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 1.5 }, // stop loss = atr_mult * ATR
    tp_rr:        { type: 'number', required: false, default: 2.0 }, // take profit = tp_rr * risk
    atr_period:   { type: 'number', required: false, default: 14 },
  }
}

// --- Helper functions ---

function findPivots(candles, left, right) {
  const highs = []
  const lows = []
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].h > candles[i].h) isHigh = false
      if (candles[j].l < candles[i].l) isLow = false
    }
    if (isHigh) highs.push({ price: candles[i].h, t: candles[i].t, bar: i })
    if (isLow)  lows.push({ price: candles[i].l, t: candles[i].t, bar: i })
  }
  return { highs, lows }
}

function buildLevels(pivots, candles, minSpacing, minTests) {
  const all = [...pivots.highs.map(p => ({ ...p, type: 'resistance' })),
               ...pivots.lows.map(p => ({ ...p, type: 'support' }))]
  all.sort((a, b) => a.price - b.price)

  // Merge levels within minSpacing
  const merged = []
  for (const lvl of all) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(lvl.price - last.price) / last.price < minSpacing) {
      // Merge — update price to average, increment test count
      last.price = (last.price * last.tests + lvl.price) / (last.tests + 1)
      last.tests++
      last.touched = Math.max(last.touched, lvl.t)
    } else {
      merged.push({ ...lvl, tests: 1, touched: lvl.t })
    }
  }

  // Filter by min test count
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

function avgVolume(candles, lookback) {
  if (candles.length < lookback) return 0
  let sum = 0
  for (let i = candles.length - lookback; i < candles.length; i++) {
    sum += candles[i].volume || candles[i].vb || 0
  }
  return sum / lookback
}

function nearestLevel(levels, price, type) {
  let nearest = null
  let minDist = Infinity
  for (const lvl of levels) {
    if (type && lvl.type !== type) continue
    const dist = Math.abs(lvl.price - price)
    if (dist < minDist) {
      minDist = dist
      nearest = lvl
    }
  }
  return nearest
}

// --- Main strategy ---

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 30) return

  const current = candles[candles.length - 1]
  const prev = candles[candles.length - 2]

  // 1. Detect pivots from candle history (exclude last `pivot_right` bars — they may not be confirmed)
  const pivotLeft = ctx.params.pivot_left
  const pivotRight = ctx.params.pivot_right
  const pivots = findPivots(candles, pivotLeft, pivotRight)

  // 2. Build S/R levels
  const levels = buildLevels(pivots, candles, ctx.params.min_spacing, ctx.params.min_tests)
  if (levels.length === 0) return

  // 3. Volume confirmation
  const avgVol = avgVolume(candles, ctx.params.lookback_vol)
  const currentVol = current.volume || current.vb || 0
  const volConfirmed = avgVol > 0 && currentVol > avgVol * ctx.params.vol_mult

  // 4. ATR for stop loss
  const atr = calcATR(candles, ctx.params.atr_period)
  if (atr <= 0) return

  // 5. Check existing positions
  const open = input.positions.open[0]

  // 6. Breakout detection
  // Find nearest resistance above and support below
  const resAbove = levels
    .filter(l => l.price > prev.c && l.type === 'resistance')
    .sort((a, b) => a.price - b.price)[0]
  const supBelow = levels
    .filter(l => l.price < prev.c && l.type === 'support')
    .sort((a, b) => b.price - a.price)[0]

  // Bullish breakout: close breaks above resistance
  const bullBreak = resAbove && current.c > resAbove.price && prev.c <= resAbove.price

  // Bearish breakout: close breaks below support
  const bearBreak = supBelow && current.c < supBelow.price && prev.c >= supBelow.price

  // 7. Entry logic
  if (!open) {
    if (bullBreak && volConfirmed) {
      const slPrice = current.c - atr * ctx.params.sl_atr_mult
      const risk = current.c - slPrice
      const tpPrice = current.c + risk * ctx.params.tp_rr

      ctx.trade({
        key: `long-${current.t}`,
        position: 'open-long',
        margin: ctx.params.margin,
        order: { type: 'market' },
        leverage: ctx.params.leverage,
        sl: slPrice,
        tp: tpPrice,
      })

      return {
        metrics: {
          signal: 'bullish_breakout',
          level: resAbove.price,
          close: current.c,
          volume_ratio: avgVol > 0 ? currentVol / avgVol : 0,
          atr,
          sl: slPrice,
          tp: tpPrice,
          levels_count: levels.length,
        }
      }
    }

    if (bearBreak && volConfirmed) {
      const slPrice = current.c + atr * ctx.params.sl_atr_mult
      const risk = slPrice - current.c
      const tpPrice = current.c - risk * ctx.params.tp_rr

      ctx.trade({
        key: `short-${current.t}`,
        position: 'open-short',
        margin: ctx.params.margin,
        order: { type: 'market' },
        leverage: ctx.params.leverage,
        sl: slPrice,
        tp: tpPrice,
      })

      return {
        metrics: {
          signal: 'bearish_breakout',
          level: supBelow.price,
          close: current.c,
          volume_ratio: avgVol > 0 ? currentVol / avgVol : 0,
          atr,
          sl: slPrice,
          tp: tpPrice,
          levels_count: levels.length,
        }
      }
    }
  }

  // 8. False breakout detection — if we have an open position, check if the breakout failed
  // (This would close the position; the SL/TP handles it in backtest, but we can add manual logic)
  if (open && open.side === 'long') {
    // Check if price closed back below the breakout level (false breakout)
    const breakoutLevel = resAbove?.price || 0
    if (breakoutLevel > 0 && current.c < breakoutLevel && prev.c < breakoutLevel) {
      // Two consecutive closes below the level — false breakout, close early
      ctx.trade({
        key: `false-bo-close-${current.t}`,
        position: 'close-long',
      })
      return {
        metrics: {
          signal: 'false_breakout_long',
          level: breakoutLevel,
          close: current.c,
        }
      }
    }
  }

  if (open && open.side === 'short') {
    const breakoutLevel = supBelow?.price || 0
    if (breakoutLevel > 0 && current.c > breakoutLevel && prev.c > breakoutLevel) {
      ctx.trade({
        key: `false-bo-close-${current.t}`,
        position: 'close-short',
      })
      return {
        metrics: {
          signal: 'false_breakout_short',
          level: breakoutLevel,
          close: current.c,
        }
      }
    }
  }

  // Return diagnostics
  return {
    metrics: {
      signal: 'none',
      close: current.c,
      levels_count: levels.length,
      nearest_res: resAbove?.price || null,
      nearest_sup: supBelow?.price || null,
      vol_ratio: avgVol > 0 ? currentVol / avgVol : 0,
      atr,
    }
  }
}