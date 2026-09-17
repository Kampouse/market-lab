//! `mlab arb live` — real-market-data arbitrage scan.
//!
//! Sources (all verified live 2026-09-17):
//!   - Binance public bookTicker (string-priced JSON, one bulk GET)
//!   - Ref Finance pools read ON-CHAIN: v2.ref-finance.near::get_pool
//!     (total_fee is in bps) + ft_metadata for symbol/decimals
//!   - synthetic USDT<->USDC bridge edge so CEX and DEX legs compose
//!
//! All pools funnel into the same Bellman-Ford scanner as `arb scan`
//! (no duplicated scan logic).

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

use crate::commands::arb::{Pool, scan_pools};

const RPC_URL: &str = "https://rpc.fastnear.com";
const REF_CONTRACT: &str = "v2.ref-finance.near";
const DEFAULT_REF_POOLS: &str = "0,1,2,3,4,792,4299,4586";
const DEFAULT_BINANCE: &str = "BTCUSDT,ETHUSDT,NEARUSDT,SOLUSDT,ETHBTC,SOLBTC,NEARBTC";

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("failed to build HTTP client")
}

/// NEAR JSON-RPC view-call returning the parsed contract return value.
async fn view_call<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    account: &str,
    method: &str,
    args: serde_json::Value,
) -> Result<T> {
    let args_bytes = serde_json::to_vec(&args)?;
    let body = json!({
        "jsonrpc": "2.0",
        "id": "mlab",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": "final",
            "account_id": account,
            "method_name": method,
            "args_base64": base64_encode(&args_bytes),
        }
    });
    let resp: RpcResponse = http
        .post(RPC_URL)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("rpc {account}::{method} request"))?
        .json()
        .await
        .with_context(|| format!("rpc {account}::{method} decode"))?;
    if let Some(err) = resp.error {
        bail!("rpc {account}::{method}: {err}");
    }
    let bytes = resp
        .result
        .and_then(|r| r.result)
        .with_context(|| format!("rpc {account}::{method}: missing result"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("{account}::{method} result"))
}

/// Minimal standard base64 (RFC 4648, with padding).
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[derive(Deserialize)]
struct RpcResponse {
    result: Option<RpcResult>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RpcResult {
    #[serde(default)]
    result: Option<Vec<u8>>, // byte values
}

#[derive(Deserialize)]
struct RawPool {
    pool_kind: serde_json::Value,
    token_account_ids: Vec<String>,
    amounts: Vec<String>,
    total_fee: f64, // basis points
}

#[derive(Deserialize)]
struct FtMeta {
    symbol: String,
    decimals: u64,
}

#[derive(Deserialize)]
struct BinanceTicker {
    symbol: String,
    #[serde(rename = "bidPrice")]
    bid_price: String,
    #[serde(rename = "askPrice")]
    ask_price: String,
    #[serde(rename = "bidQty")]
    bid_qty: String,
    #[serde(rename = "askQty")]
    ask_qty: String,
}

/// Node-name normalization so CEX and DEX symbols meet in one graph.
fn node_name(sym: &str) -> &str {
    match sym {
        "wNEAR" => "NEAR",
        "WNEAR" => "NEAR",
        "wETH" => "ETH",
        "WETH" => "ETH",
        other => other,
    }
}

async fn fetch_ref_pool(
    http: &reqwest::Client,
    id: u64,
    meta_cache: &mut std::collections::HashMap<String, (String, u64)>,
) -> Result<Pool> {
    let raw: RawPool = view_call(http, REF_CONTRACT, "get_pool", json!({ "pool_id": id }))
        .await
        .with_context(|| format!("ref get_pool({id})"))?;
    if raw.token_account_ids.len() != 2 || raw.amounts.len() != 2 {
        bail!("ref pool {id}: not a pair pool");
    }
    let kind = raw.pool_kind.as_str().unwrap_or("UNKNOWN");
    if kind != "SIMPLE_POOL" {
        bail!("ref pool {id}: {kind} (only SIMPLE_POOL xy=k supported)");
    }
    if raw.total_fee <= 0.0 || raw.total_fee >= 10_000.0 {
        bail!("ref pool {id}: absurd fee {}bps", raw.total_fee);
    }

    let mut decimals = Vec::with_capacity(2);
    let mut syms = Vec::with_capacity(2);
    for tok in &raw.token_account_ids {
        let (sym, dec) = match meta_cache.get(tok) {
            Some(v) => v.clone(),
            None => {
                let m: FtMeta = view_call(http, tok, "ft_metadata", json!({})).await?;
                let v = (m.symbol, m.decimals);
                meta_cache.insert(tok.clone(), v.clone());
                v
            }
        };
        syms.push(sym);
        decimals.push(dec);
    }

    let a0: f64 =
        raw.amounts[0].parse::<f64>().context("bad amount0")? / 10f64.powi(decimals[0] as i32);
    let a1: f64 =
        raw.amounts[1].parse::<f64>().context("bad amount1")? / 10f64.powi(decimals[1] as i32);
    if a0 <= 0.0 || a1 <= 0.0 {
        bail!("ref pool {id}: empty reserves");
    }
    let mid = a1 / a0;
    let f = 1.0 - raw.total_fee / 10_000.0;
    Ok(Pool {
        id: format!("ref{id}"),
        venue: "ref".into(),
        base: node_name(&syms[0]).into(),
        quote: node_name(&syms[1]).into(),
        bid: mid * f,
        ask: mid / f,
        fee_bps: raw.total_fee,
        cprod: Some((a0, a1)),
        book_qty: None,
    })
}

async fn fetch_binance(http: &reqwest::Client, symbols: &[&str]) -> Result<Vec<Pool>> {
    let mut pools = Vec::new();
    for &sym in symbols {
        // Depth endpoint: L1 prices for the graph, ±1%-band cumulative qty as
        // the executable-depth cap (bookTicker L1 qty alone is far too thin).
        let Ok(book) = http
            .get("https://api.binance.com/api/v3/depth")
            .query(&[("symbol", sym), ("limit", "50")])
            .send()
            .await
            .context("binance depth request failed")?
            .json::<BinanceDepth>()
            .await
            .context("binance depth decode failed")
        else {
            eprintln!("  {sym}: skipped (depth fetch failed)");
            continue;
        };
        let (Some(bb), Some(ba)) = (book.bids.first(), book.asks.first()) else {
            eprintln!("  {sym}: skipped (empty book)");
            continue;
        };
        let (Ok(bid), Ok(ask)) = (bb[0].parse::<f64>(), ba[0].parse::<f64>()) else {
            continue;
        };
        if bid <= 0.0 || ask <= 0.0 {
            continue;
        }
        let mid = (bid + ask) / 2.0;
        let band_bid: f64 = book
            .bids
            .iter()
            .filter(|l| l[0].parse::<f64>().unwrap_or(0.0) >= mid * 0.99)
            .filter_map(|l| l[1].parse::<f64>().ok())
            .sum();
        let band_ask: f64 = book
            .asks
            .iter()
            .filter(|l| l[0].parse::<f64>().unwrap_or(f64::INFINITY) <= mid * 1.01)
            .filter_map(|l| l[1].parse::<f64>().ok())
            .sum();
        let (base, quote) = if let Some(b) = sym.strip_suffix("USDT") {
            (b, "USDT")
        } else if let Some(b) = sym.strip_suffix("BTC") {
            (b, "BTC")
        } else {
            continue;
        };
        pools.push(Pool {
            id: sym.to_string(),
            venue: "binance".into(),
            base: node_name(base).into(),
            quote: quote.into(),
            bid,
            ask,
            fee_bps: 10.0, // taker
            cprod: None,
            book_qty: Some((band_bid, band_ask)),
        });
    }
    Ok(pools)
}

#[derive(Deserialize)]
struct BinanceDepth {
    bids: Vec<[String; 2]>, // [price, qty], best first
    asks: Vec<[String; 2]>,
}

pub async fn handle(
    pools_arg: Vec<u64>,
    binance_arg: Vec<String>,
    capital: f64,
    out: Option<std::path::PathBuf>,
) -> Result<()> {
    let http = http()?;
    let ref_ids: Vec<u64> = if pools_arg.is_empty() {
        DEFAULT_REF_POOLS
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect()
    } else {
        pools_arg
    };
    let bin_syms: Vec<String> = if binance_arg.is_empty() {
        DEFAULT_BINANCE.split(',').map(String::from).collect()
    } else {
        binance_arg
    };
    let bin_refs: Vec<&str> = bin_syms.iter().map(String::as_str).collect();

    println!(
        "live scan: {} ref pools (on-chain), {} binance pairs",
        ref_ids.len(),
        bin_refs.len()
    );

    let mut meta_cache = std::collections::HashMap::new();
    let mut pools: Vec<Pool> = Vec::new();

    for id in &ref_ids {
        match fetch_ref_pool(&http, *id, &mut meta_cache).await {
            Ok(p) => pools.push(p),
            Err(e) => println!("  ref{}: skipped ({e:#})", id),
        }
    }
    pools.extend(fetch_binance(&http, &bin_refs).await?);

    // Synthetic stable bridge: lets USDT-side CEX books compose with
    // USDC-side DEX pools (1bp round trip, conservative).
    let has_usdt = pools.iter().any(|p| p.quote == "USDT" || p.base == "USDT");
    let has_usdc = pools.iter().any(|p| p.quote == "USDC" || p.base == "USDC");
    if has_usdt && has_usdc {
        pools.push(Pool {
            id: "usdtusdc".into(),
            venue: "synth".into(),
            base: "USDT".into(),
            quote: "USDC".into(),
            bid: 0.9999,
            ask: 1.0001,
            fee_bps: 1.0,
            cprod: None,
            book_qty: None,
        });
    }

    println!("usable pools: {} — scanning", pools.len());
    if pools.len() < 3 {
        bail!("fewer than 3 usable pools; nothing to scan");
    }

    if let Some(path) = out {
        std::fs::write(
            path,
            serde_json::to_string_pretty(&pools).context("serialize snapshot")?,
        )?;
        println!("snapshot written");
    }

    scan_pools(&pools, capital)
}
