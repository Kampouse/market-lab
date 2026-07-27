// Pivot Hunter Scalp — Market Lab strategy
// Built for speed: 5m candles, 2/2 pivots, fast EMAs, quick 1R exits.
// No ADX filter, no cooldown — trades every valid breakout.

export const script = {
  name: 'pivot-scalp',
  version: '1',
  sources: ['candles'],
  lookback: 100,
  params: {
    // Pivot detection — tight for more levels
    pivot_left:   { type: 'number', required: false, default: 2 },
    pivot_right:  { type: 'number', required: false, default: 2 },
    min_spacing:  { type: 'number', required: false, default: 0.001 },
    min_tests:    { type: 'number', required: false, default: 1 },

    // Fast EMA filter — only blocks counter-trend
    ema_fast:     { type: 'number', required: false, default: 9 },
    ema_slow:     { type: 'number', required: false, default: 21 },

    // Volume — just above average
    vol_mult:     { type: 'number', required: false, default: 1.0 },
    lookback_vol: { type: 'number', required: false, default: 10 },

    // Risk — tight for scalping
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 1.0 },
    tp_rr:        { type: 'number', required: false, default: 1.0 },
    atr_period:   { type: 'number', required: false, default: 14 },

    // Quick false breakout exit — 2 bars max
    false_bo_bars: { type: 'number', required: false, default: 2 },

    // No cooldown — trade every signal
    cooldown_bars: { type: 'number', required: false, default: 0 },
  }
}

// --- Helpers ---

function ema(candles, period) {
  if (candles.length < period) return candles[candles.length - 1].c
  const k = 2 / (period + 1)
  let e = candles[candles.length - period].c
  for (let i = candles.length - period + 1; i < candles.length; i++)
    e = candles[i].c * k + e * (1 - k)
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
    if (isHigh) highs.push({ price: candles[i].h, bar: i })
    if (isLow)  lows.push({ price: candles[i].l, bar: i })
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
let entryInfo = null

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 20) return

  const idx = candles.length - 1
  const current = candles[idx]
  const prev = candles[idx - 1]
  if (!prev) return

  // 1. Fast EMA trend
  const emaF = ema(candles, ctx.params.ema_fast)
  const emaS = ema(candles, ctx.params.ema_slow)
  const uptrend = emaF > emaS
  const downtrend = emaF < emaS

  // 2. Pivots & levels
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
  if (ctx.params.cooldown_bars > 0 && idx - lastTradeBar < ctx.params.cooldown_bars) return

  // 6. Find levels near price — wider band for more signals
  const near = 0.008 // 0.8% — wider than v5's 0.5%
  const resNear = levels
    .filter(l => l.type === 'resistance' && l.price > current.c * (1 - near) && l.price < current.c * (1 + near))
    .sort((a, b) => a.price - b.price)
  const supNear = levels
    .filter(l => l.type === 'support' && l.price < current.c * (1 + near) && l.price > current.c * (1 - near))
    .sort((a, b) => b.price - a.price)

  // 7. Check open position
  const open = input.positions.open[0]

  // 8. Entry
  if (!open) {
    entryInfo = null
    if (volOK) {
      // Long breakout
      for (const lvl of resNear) {
        if (prev.c < lvl.price && current.c > lvl.price && uptrend) {
          const sl = current.c - atr * ctx.params.sl_atr_mult
          const tp = current.c + (current.c - sl) * ctx.params.tp_rr
          lastTradeBar = idx
          entryInfo = { side: 'long', level: lvl.price, entryBar: idx }
          ctx.trade({
            key: `l-${current.t}`, position: 'open-long',
            margin: ctx.params.margin, order: { type: 'market' },
            leverage: ctx.params.leverage, sl, tp,
          })
          return { metrics: { signal: 'long', level: lvl.price, close: current.c, atr: Math.round(atr) } }
        }
      }
      // Short breakout
      for (const lvl of supNear) {
        if (prev.c > lvl.price && current.c < lvl.price && downtrend) {
          const sl = current.c + atr * ctx.params.sl_atr_mult
          const tp = current.c - (sl - current.c) * ctx.params.tp_rr
          lastTradeBar = idx
          entryInfo = { side: 'short', level: lvl.price, entryBar: idx }
          ctx.trade({
            key: `s-${current.t}`, position: 'open-short',
            margin: ctx.params.margin, order: { type: 'market' },
            leverage: ctx.params.leverage, sl, tp,
          })
          return { metrics: { signal: 'short', level: lvl.price, close: current.c, atr: Math.round(atr) } }
        }
      }
    }
  }

  // 9. False breakout exit
  if (open && entryInfo) {
    const barsSince = idx - entryInfo.entryBar
    if (barsSince <= ctx.params.false_bo_bars) {
      if (entryInfo.side === 'long' && current.c < entryInfo.level && prev.c < entryInfo.level) {
        ctx.trade({ key: `x-${current.t}`, position: 'close-long' })
        lastTradeBar = idx
        const lv = entryInfo.level; entryInfo = null
        return { metrics: { signal: 'fake_long', close: current.c, level: lv } }
      }
      if (entryInfo.side === 'short' && current.c > entryInfo.level && prev.c > entryInfo.level) {
        ctx.trade({ key: `x-${current.t}`, position: 'close-short' })
        lastTradeBar = idx
        const lv = entryInfo.level; entryInfo = null
        return { metrics: { signal: 'fake_short', close: current.c, level: lv } }
      }
    }
  }

  if (!open) entryInfo = null
  return { metrics: { signal: 'none', close: current.c, ema: Math.round(emaF), levels: levels.length } }
}