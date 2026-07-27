// Momentum Scalp — for NEAR/USDT
// Trend-following: EMA crossover + momentum thrust entry, ATR trailing stop.
// Designed for BTC-correlated assets that don't form clean S/R levels.

export const script = {
  name: 'momentum-scalp',
  version: '1',
  sources: ['candles'],
  lookback: 200,
  params: {
    // EMA trend filter
    ema_fast:     { type: 'number', required: false, default: 9 },
    ema_slow:     { type: 'number', required: false, default: 21 },
    ema_macro:    { type: 'number', required: false, default: 50 },  // macro trend

    // Momentum thrust — candle body must be > X% of ATR
    thrust_atr:   { type: 'number', required: false, default: 0.5 }, // body >= 0.5 * ATR

    // RSI filter — not overbought/oversold
    rsi_period:   { type: 'number', required: false, default: 14 },
    rsi_min:      { type: 'number', required: false, default: 30 },
    rsi_max:      { type: 'number', required: false, default: 70 },

    // Volume confirmation
    vol_mult:     { type: 'number', required: false, default: 1.0 },
    lookback_vol: { type: 'number', required: false, default: 10 },

    // Risk
    margin:       { type: 'number', required: false, default: 100 },
    leverage:     { type: 'number', required: false, default: 10 },
    sl_atr_mult:  { type: 'number', required: false, default: 1.0 },
    tp_rr:        { type: 'number', required: false, default: 1.5 },
    atr_period:   { type: 'number', required: false, default: 14 },

    // Trailing stop — activate after X% of TP reached
    trail_activate: { type: 'number', required: false, default: 0.5 }, // 50% of TP distance
    trail_atr_mult: { type: 'number', required: false, default: 0.8 }, // trail = 0.8 ATR

    // Cooldown
    cooldown_bars: { type: 'number', required: false, default: 2 },
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

function emaArr(candles, period) {
  if (candles.length < period) return candles.map(c => c.c)
  const k = 2 / (period + 1)
  const arr = []
  let e = candles[0].c
  for (let i = 0; i < candles.length; i++) {
    e = candles[i].c * k + e * (1 - k)
    arr.push(e)
  }
  return arr
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

function calcRSI(candles, period) {
  if (candles.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].c - candles[i - 1].c
    if (change > 0) gains += change
    else losses -= change
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

// --- State ---
let lastTradeBar = -999
let entryInfo = null

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 50) return

  const idx = candles.length - 1
  const current = candles[idx]
  const prev = candles[idx - 1]
  if (!prev) return

  // 1. EMAs
  const emaF = ema(candles, ctx.params.ema_fast)
  const emaS = ema(candles, ctx.params.ema_slow)
  const emaM = ema(candles, ctx.params.ema_macro)

  // Trend: fast > slow > macro = strong uptrend, reverse = strong downtrend
  const uptrend = emaF > emaS
  const downtrend = emaF < emaS
  const macroUp = emaS > emaM
  const macroDown = emaS < emaM

  // 2. Momentum thrust — body size relative to ATR
  const atr = calcATR(candles, ctx.params.atr_period)
  if (atr <= 0) return
  const body = Math.abs(current.c - current.o)
  const thrustOK = body >= atr * ctx.params.thrust_atr
  const bullCandle = current.c > current.o
  const bearCandle = current.c < current.o

  // 3. RSI
  const rsi = calcRSI(candles, ctx.params.rsi_period)
  const rsiOK = rsi >= ctx.params.rsi_min && rsi <= ctx.params.rsi_max

  // 4. Volume
  const vols = candles.map(c => c.volume || c.vb || 0)
  const avgVol = smaArr(vols, ctx.params.lookback_vol)
  const currentVol = current.volume || current.vb || 0
  const volOK = avgVol > 0 && currentVol >= avgVol * ctx.params.vol_mult

  // 5. Cooldown
  if (ctx.params.cooldown_bars > 0 && idx - lastTradeBar < ctx.params.cooldown_bars) return

  // 6. Check open position
  const open = input.positions.open[0]

  // 7. Entry — momentum thrust in trend direction
  if (!open) {
    entryInfo = null
    if (volOK && rsiOK && thrustOK) {
      // Long: EMA fast > slow, macro up, bullish thrust candle
      if (uptrend && macroUp && bullCandle) {
        const sl = current.c - atr * ctx.params.sl_atr_mult
        const tpDist = (current.c - sl) * ctx.params.tp_rr
        const tp = current.c + tpDist
        lastTradeBar = idx
        entryInfo = { side: 'long', entry: current.c, sl, tp, tpDist, trailActive: false, entryBar: idx }
        ctx.trade({
          key: `l-${current.t}`, position: 'open-long',
          margin: ctx.params.margin, order: { type: 'market' },
          leverage: ctx.params.leverage, sl, tp,
        })
        return { metrics: { signal: 'long', close: current.c, rsi: Math.round(rsi), atr: Math.round(atr), thrust: body.toFixed(4) } }
      }
      // Short: EMA fast < slow, macro down, bearish thrust candle
      if (downtrend && macroDown && bearCandle) {
        const sl = current.c + atr * ctx.params.sl_atr_mult
        const tpDist = (sl - current.c) * ctx.params.tp_rr
        const tp = current.c - tpDist
        lastTradeBar = idx
        entryInfo = { side: 'short', entry: current.c, sl, tp, tpDist, trailActive: false, entryBar: idx }
        ctx.trade({
          key: `s-${current.t}`, position: 'open-short',
          margin: ctx.params.margin, order: { type: 'market' },
          leverage: ctx.params.leverage, sl, tp,
        })
        return { metrics: { signal: 'short', close: current.c, rsi: Math.round(rsi), atr: Math.round(atr), thrust: body.toFixed(4) } }
      }
    }
  }

  // 8. Trailing stop — move SL as price moves in favor
  if (open && entryInfo) {
    const barsSince = idx - entryInfo.entryBar
    // Activate trailing after price moves >= trail_activate * tpDist
    if (entryInfo.side === 'long') {
      const profit = current.c - entryInfo.entry
      if (!entryInfo.trailActive && profit >= entryInfo.tpDist * ctx.params.trail_activate) {
        entryInfo.trailActive = true
      }
      if (entryInfo.trailActive) {
        const newSL = current.c - atr * ctx.params.trail_atr_mult
        if (newSL > entryInfo.sl) {
          entryInfo.sl = newSL
          ctx.trade({
            key: `ts-${current.t}`, position: 'open-long',
            margin: ctx.params.margin, order: { type: 'market' },
            leverage: ctx.params.leverage, sl: newSL, tp: entryInfo.tp,
          })
          return { metrics: { signal: 'trail_long', close: current.c, new_sl: newSL.toFixed(4) } }
        }
      }
    }
    if (entryInfo.side === 'short') {
      const profit = entryInfo.entry - current.c
      if (!entryInfo.trailActive && profit >= entryInfo.tpDist * ctx.params.trail_activate) {
        entryInfo.trailActive = true
      }
      if (entryInfo.trailActive) {
        const newSL = current.c + atr * ctx.params.trail_atr_mult
        if (newSL < entryInfo.sl) {
          entryInfo.sl = newSL
          ctx.trade({
            key: `ts-${current.t}`, position: 'open-short',
            margin: ctx.params.margin, order: { type: 'market' },
            leverage: ctx.params.leverage, sl: newSL, tp: entryInfo.tp,
          })
          return { metrics: { signal: 'trail_short', close: current.c, new_sl: newSL.toFixed(4) } }
        }
      }
    }
  }

  if (!open) entryInfo = null
  return { metrics: { signal: 'none', close: current.c, ema_f: Math.round(emaF), ema_s: Math.round(emaS), rsi: Math.round(rsi) } }
}