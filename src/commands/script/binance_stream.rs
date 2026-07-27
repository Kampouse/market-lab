// Binance Futures WebSocket streamer for mlab script run --paper
// Connects to wss://fstream.binance.com/ws and streams kline data

use std::collections::VecDeque;
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};

use crate::scripting::market_data::ScriptCandle;

const BINANCE_WS_BASE: &str = "wss://fstream.binance.com/ws";

#[derive(Debug, Clone, Deserialize)]
struct KlineData {
    #[serde(rename = "t")] open_time: i64,
    #[serde(rename = "T")] close_time: i64,
    #[serde(rename = "o")] open: String,
    #[serde(rename = "h")] high: String,
    #[serde(rename = "l")] low: String,
    #[serde(rename = "c")] close: String,
    #[serde(rename = "v")] volume: String,
    #[serde(rename = "n")] trade_count: i64,
    #[serde(rename = "x")] is_closed: bool,
}

#[derive(Debug, Deserialize)]
struct KlineMessage {
    #[serde(rename = "e")] event_type: String,
    #[serde(rename = "k")] kline: KlineData,
}

/// Binance WS client that streams completed candles.
pub struct BinanceCandleStream {
    rx: mpsc::Receiver<Result<ScriptCandle>>,
}

impl BinanceCandleStream {
    /// Connect to Binance Futures WS and subscribe to kline updates.
    pub async fn connect(symbol: &str, interval: &str) -> Result<Self> {
        let sym = symbol.replace('/', "").to_uppercase();
        let stream_name = format!("{sym}@kline_{interval}");
        let url = format!("{BINANCE_WS_BASE}/{stream_name}");

        let (tx, rx) = mpsc::channel(256);

        tokio::spawn(async move {
            if let Err(e) = run_ws_loop(&url, &tx).await {
                let _ = tx.send(Err(anyhow::anyhow!("Binance WS: {e}"))).await;
            }
        });

        Ok(Self { rx })
    }

    /// Wait for the next completed candle.
    pub async fn next_candle(&mut self) -> Result<ScriptCandle> {
        match self.rx.recv().await {
            Some(Ok(candle)) => Ok(candle),
            Some(Err(e)) => Err(e),
            None => bail!("Binance WS stream closed"),
        }
    }
}

/// Multi-symbol stream: each candle is tagged with the symbol it came from.
pub struct BinanceMultiCandleStream {
    rx: mpsc::Receiver<Result<(String, ScriptCandle)>>,
}

impl BinanceMultiCandleStream {
    /// Connect to Binance Futures WS and subscribe to multiple symbol kline streams.
    /// Binance combined streams: wss://fstream.binance.com/stream?streams=btcusdt@kline_15m/zecusdt@kline_15m
    pub async fn connect_multi(symbols: &[String], interval: &str) -> Result<Self> {
        use std::collections::HashMap;

        let streams: Vec<String> = symbols
            .iter()
            .map(|s| {
                let sym = s.replace('/', "").to_uppercase();
                format!("{sym}@kline_{interval}")
            })
            .collect();
        let stream_path = streams.join("/");
        let url = format!("wss://fstream.binance.com/stream?streams={stream_path}");

        // Map stream name → symbol for tagging
        let mut stream_to_symbol: HashMap<String, String> = HashMap::new();
        for sym in symbols {
            let s = sym.replace('/', "").to_uppercase();
            stream_to_symbol.insert(format!("{s}@kline_{interval}"), sym.clone());
        }

        let (tx, rx) = mpsc::channel(256);

        tokio::spawn(async move {
            if let Err(e) = run_multi_ws_loop(&url, &tx, &stream_to_symbol).await {
                let _ = tx
                    .send(Err(anyhow::anyhow!("Binance WS multi: {e}")))
                    .await;
            }
        });

        Ok(Self { rx })
    }

    /// Wait for the next completed candle along with its symbol.
    pub async fn next_candle(&mut self) -> Result<(String, ScriptCandle)> {
        match self.rx.recv().await {
            Some(Ok(item)) => Ok(item),
            Some(Err(e)) => Err(e),
            None => bail!("Binance WS multi stream closed"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct CombinedStreamMessage {
    stream: String,
    data: KlineMessage,
}

async fn run_multi_ws_loop(
    url: &str,
    tx: &mpsc::Sender<Result<(String, ScriptCandle)>>,
    stream_to_symbol: &std::collections::HashMap<String, String>,
) -> Result<()> {
    loop {
        let (ws_stream, _) = connect_async(url)
            .await
            .context("failed to connect to Binance WS combined stream")?;

        let (mut write, mut read) = ws_stream.split();

        while let Some(msg) = read.next().await {
            let msg = match msg {
                Ok(Message::Text(text)) => text,
                Ok(Message::Binary(data)) => String::from_utf8_lossy(&data).to_string().into(),
                Ok(Message::Ping(ping)) => {
                    let _ = write.send(Message::Pong(ping)).await;
                    continue;
                }
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    let _ = tx
                        .send(Err(anyhow::anyhow!("WS read error: {e}")))
                        .await;
                    break;
                }
                _ => continue,
            };

            // Combined stream format: {"stream":"btcusdt@kline_15m","data":{...}}
            let parsed: Result<CombinedStreamMessage, _> = serde_json::from_str(&msg);
            let combined = match parsed {
                Ok(c) => c,
                Err(_) => continue,
            };

            if combined.data.event_type != "kline" {
                continue;
            }

            let k = combined.data.kline;
            if !k.is_closed {
                continue;
            }

            let symbol = match stream_to_symbol.get(&combined.stream) {
                Some(s) => s.clone(),
                None => continue,
            };

            let candle = ScriptCandle {
                t: k.open_time as u64,
                o: k.open.parse().unwrap_or(0.0),
                h: k.high.parse().unwrap_or(0.0),
                l: k.low.parse().unwrap_or(0.0),
                c: k.close.parse().unwrap_or(0.0),
                volume: k.volume.parse().unwrap_or(0.0),
                trades: k.trade_count as u64,
                close_time: Some(k.close_time as u64),
                vb: None,
                vs: None,
                tb: None,
                ts: None,
            };

            if tx.send(Ok((symbol, candle))).await.is_err() {
                return Ok(()); // Receiver dropped
            }
        }

        // Reconnect after disconnect
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn run_ws_loop(
    url: &str,
    tx: &mpsc::Sender<Result<ScriptCandle>>,
) -> Result<()> {
    loop {
        let (ws_stream, _) = connect_async(url)
            .await
            .context("failed to connect to Binance WS")?;

        let (mut write, mut read) = ws_stream.split();

        while let Some(msg) = read.next().await {
            let msg = match msg {
                Ok(Message::Text(text)) => text,
                Ok(Message::Binary(data)) => String::from_utf8_lossy(&data).to_string().into(),
                Ok(Message::Ping(ping)) => {
                    let _ = write.send(Message::Pong(ping)).await;
                    continue;
                }
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    let _ = tx.send(Err(anyhow::anyhow!("WS read error: {e}"))).await;
                    break;
                }
                _ => continue,
            };

            let parsed: Result<KlineMessage, _> = serde_json::from_str(&msg);
            let kline_msg = match parsed {
                Ok(m) => m,
                Err(_) => continue,
            };

            if kline_msg.event_type != "kline" {
                continue;
            }

            let k = kline_msg.kline;

            // Only forward completed candles
            if !k.is_closed {
                continue;
            }

            let candle = ScriptCandle {
                t: k.open_time as u64,
                o: k.open.parse().unwrap_or(0.0),
                h: k.high.parse().unwrap_or(0.0),
                l: k.low.parse().unwrap_or(0.0),
                c: k.close.parse().unwrap_or(0.0),
                volume: k.volume.parse().unwrap_or(0.0),
                trades: k.trade_count as u64,
                close_time: Some(k.close_time as u64),
                vb: None,
                vs: None,
                tb: None,
                ts: None,
            };

            if tx.send(Ok(candle)).await.is_err() {
                return Ok(()); // Receiver dropped
            }
        }

        // Reconnect after disconnect
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

/// Map seconds to Binance interval strings.
pub fn seconds_to_binance_interval(seconds: u64) -> Result<String> {
    match seconds {
        60 => Ok("1m".into()),
        180 => Ok("3m".into()),
        300 => Ok("5m".into()),
        900 => Ok("15m".into()),
        1800 => Ok("30m".into()),
        3600 => Ok("1h".into()),
        14400 => Ok("4h".into()),
        86400 => Ok("1d".into()),
        _ => bail!("unsupported timeframe: {seconds}s"),
    }
}
