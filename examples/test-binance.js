export const script = {
  name: 'test-binance',
  version: '1',
  sources: ['candles'],
  lookback: 20,
  params: {}
}

export function onData(ctx, input, history) {
  if (input.source_type !== 'candles') return

  const candles = history.source('candles@binance_futures')
  if (candles.length < 10) return

  const current = candles[candles.length - 1]
  const prev = candles[candles.length - 2]

  // Simple: return close price as metric
  return {
    metrics: {
      close: current.c,
      prev_close: prev.c,
      change: current.c - prev.c,
      count: candles.length
    }
  }
}