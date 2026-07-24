// OpenFinance execution provider for market-lab
// Wraps the OpenFinance backend API (https://api.openfinance.tech/agent/trading/*)
// which proxies to Hyperliquid perps.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};


use crate::domain::execution::{
    AccountSnapshot, ExecutionReceipt, ExecutionVenue,
    MarginSummary, OrderKind, Position, PositionDirection,
    TimeInForce, VenueCapabilities,
};

const OPENFINANCE_BASE_URL: &str = "https://api.openfinance.tech/agent/trading";
const HTTP_TIMEOUT_SECS: u64 = 15;

/// Resolve the OpenFinance API key from env or config.
pub fn resolve_api_key() -> Result<String> {
    if let Ok(key) = std::env::var("OPENFINANCE_API_KEY") {
        if key.starts_with("open_") {
            return Ok(key);
        }
    }
    bail!("OPENFINANCE_API_KEY env var not set or invalid (must start with 'open_'). Get one at https://openfinance.tech")
}

pub struct OpenFinanceClient {
    client: Client,
    api_key: String,
}

impl OpenFinanceClient {
    pub fn new() -> Result<Self> {
        let api_key = resolve_api_key()?;
        let client = Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
            .context("failed to build HTTP client")?;
        Ok(Self { client, api_key })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", OPENFINANCE_BASE_URL, path)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        let resp = self
            .client
            .get(self.url(path))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .context(format!("GET {path} failed"))?;
        let status = resp.status();
        let body: Value = resp.json().await.context("failed to decode response")?;
        if !status.is_success() {
            bail!("GET {path} returned HTTP {status}: {}", error_message(&body));
        }
        Ok(body)
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        let resp = self
            .client
            .post(self.url(path))
            .header("x-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .context(format!("POST {path} failed"))?;
        let status = resp.status();
        let resp_body: Value = resp.json().await.context("failed to decode response")?;
        if !status.is_success() {
            bail!("POST {path} returned HTTP {status}: {}", error_message(&resp_body));
        }
        Ok(resp_body)
    }

    async fn delete(&self, path: &str, body: &Value) -> Result<Value> {
        let resp = self
            .client
            .delete(self.url(path))
            .header("x-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .context(format!("DELETE {path} failed"))?;
        let status = resp.status();
        let resp_body: Value = resp.json().await.context("failed to decode response")?;
        if !status.is_success() {
            bail!("DELETE {path} returned HTTP {status}: {}", error_message(&resp_body));
        }
        Ok(resp_body)
    }
}

fn error_message(body: &Value) -> String {
    body.get("message")
        .and_then(Value::as_str)
        .or_else(|| body.get("error").and_then(Value::as_str))
        .unwrap_or("unknown error")
        .to_string()
}

// ── Asset index resolution ──

/// Resolve a coin symbol (e.g. "BTC", "ETH", "NEAR") to its numeric asset index.
/// Cached after first call per session.
pub async fn resolve_asset_index(client: &OpenFinanceClient, coin: &str) -> Result<(usize, usize)> {
    let metas = client.get("/market/perp-metas").await?;
    // Find the asset in the main DEX universe
    let universe = metas
        .get("universe")
        .and_then(Value::as_array)
        .context("perp-metas missing universe array")?;

    for (i, asset) in universe.iter().enumerate() {
        let name = asset.get("name").and_then(Value::as_str).unwrap_or("");
        if name.eq_ignore_ascii_case(coin) {
            let sz_decimals = asset
                .get("szDecimals")
                .and_then(Value::as_u64)
                .unwrap_or(4) as usize;
            return Ok((i, sz_decimals));
        }
    }
    bail!("asset '{coin}' not found in Hyperliquid perp universe");
}

// ── Account ──

pub async fn get_account(client: &OpenFinanceClient) -> Result<AccountSnapshot> {
    let resp = client.get("/account").await?;
    parse_account(&resp)
}

fn parse_account(body: &Value) -> Result<AccountSnapshot> {
    let clearinghouse = body
        .pointer("/clearinghouseState")
        .context("missing clearinghouseState")?;
    let margin_summary = clearinghouse
        .pointer("/marginSummary")
        .context("missing marginSummary")?;

    let total_balance = margin_summary
        .get("accountValue")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let margin_used = margin_summary
        .get("totalMarginUsed")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let notional = margin_summary
        .get("totalNtlPos")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    // Include spot USDC
    let spot_usdc = body
        .pointer("/spotClearinghouseState/balances")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find(|b| b.get("coin").and_then(Value::as_str) == Some("USDC"))
        })
        .and_then(|usdc| usdc.get("total").and_then(Value::as_str))
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let available = clearinghouse
        .get("withdrawable")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
        + spot_usdc;

    let positions = parse_positions(clearinghouse)?;
    let open_orders = Vec::new(); // fetched separately if needed

    Ok(AccountSnapshot {
        venue: ExecutionVenue::OpenFinance,
        account: "hyperliquid".to_string(),
        fetched_at_ms: now_ms(),
        margin: MarginSummary {
            total_balance: total_balance + spot_usdc,
            available_balance: available,
            margin_used,
            notional,
            realized_pnl: 0.0,
            unrealized_pnl: margin_summary
                .get("totalRawUsd")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<f64>().ok())
                .map(|v| v - total_balance)
                .unwrap_or(0.0),
            fees: 0.0,
            funding: 0.0,
        },
        positions,
        open_orders,
        leverage_settings: Vec::new(),
    })
}

fn parse_positions(clearinghouse: &Value) -> Result<Vec<Position>> {
    let asset_positions = clearinghouse
        .get("assetPositions")
        .and_then(Value::as_array)
        .context("missing assetPositions")?;

    let mut positions = Vec::new();
    for ap in asset_positions {
        let pos = ap.pointer("/position").unwrap_or(ap);
        let coin = pos.get("coin").and_then(Value::as_str).unwrap_or("?");
        let size: f64 = pos
            .get("szi")
            .or_else(|| pos.get("size"))
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0.0);
        if size.abs() < 1e-10 {
            continue;
        }

        let entry_px: f64 = pos
            .get("entryPx")
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0.0);
        let mark_px: f64 = pos
            .get("markPx")
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0.0);
        let leverage: f64 = pos
            .get("leverage")
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(1.0);
        let liq_px: f64 = pos
            .get("liquidationPx")
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0.0);
        let unrealized_pnl: f64 = pos
            .get("unrealizedPnl")
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0.0);

        positions.push(Position {
            venue: ExecutionVenue::OpenFinance,
            internal_symbol: format!("{coin}/USDT"),
            venue_symbol: coin.to_string(),
            catalog_supported: false,
            direction: if size > 0.0 {
                PositionDirection::Long
            } else {
                PositionDirection::Short
            },
            size: size.abs(),
            entry_price: entry_px,
            mark_price: mark_px,
            notional: size.abs() * mark_px,
            realized_pnl: 0.0,
            unrealized_pnl,
            leverage,
            liquidation_price: liq_px,
            fees: 0.0,
            funding: 0.0,
            maintenance_margin: 0.0,
        });
    }
    Ok(positions)
}

// ── Orders ──

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenFinanceOrderRequest {
    pub coin: String,
    pub is_buy: bool,
    pub sz: String,
    pub limit_px: String,
    pub order_type: OpenFinanceOrderType,
    pub reduce_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OpenFinanceOrderType {
    #[serde(rename = "ioc")]
    Ioc,
    #[serde(rename = "gtc")]
    Gtc,
    #[serde(rename = "alo")]
    Alo,
}

impl OpenFinanceOrderType {
    fn tif_string(&self) -> &'static str {
        match self {
            Self::Ioc => "Ioc",
            Self::Gtc => "Gtc",
            Self::Alo => "Alo",
        }
    }
}

/// Place an order via OpenFinance → Hyperliquid.
/// Uses the single-letter field names that Hyperliquid requires.
pub async fn place_order(
    client: &OpenFinanceClient,
    asset_index: usize,
    is_buy: bool,
    sz: f64,
    limit_px: f64,
    tif: &str,
    reduce_only: bool,
) -> Result<ExecutionReceipt> {
    let body = json!({
        "orders": [{
            "a": asset_index,
            "b": is_buy,
            "p": format!("{limit_px}"),
            "s": format!("{sz}"),
            "r": reduce_only,
            "t": { "limit": { "tif": tif } }
        }],
        "grouping": "na"
    });

    let resp = client.post("/orders", &body).await?;
    let status = resp
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    Ok(ExecutionReceipt {
        venue: ExecutionVenue::OpenFinance,
        account: "hyperliquid".to_string(),
        order_id: resp
            .pointer("/response/data/statuses/0/resting")
            .and_then(|v| {
                v.as_u64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(|s| s.to_string()))
            }),
        status: status.to_string(),
        terminal: status == "ok" || status == "filled",
        submitted_at_ms: now_ms(),
        raw_status: resp,
    })
}

/// Place a trigger order (stop loss or take profit).
pub async fn place_trigger_order(
    client: &OpenFinanceClient,
    asset_index: usize,
    is_buy: bool,
    sz: f64,
    trigger_px: f64,
    is_market: bool,
    tpsl: &str, // "tp" or "sl"
    reduce_only: bool,
) -> Result<ExecutionReceipt> {
    let body = json!({
        "orders": [{
            "a": asset_index,
            "b": is_buy,
            "p": format!("{trigger_px}"),
            "s": format!("{sz}"),
            "r": reduce_only,
            "t": {
                "trigger": {
                    "isMarket": is_market,
                    "triggerPx": format!("{trigger_px}"),
                    "tpsl": tpsl
                }
            }
        }],
        "grouping": "na"
    });

    let resp = client.post("/orders", &body).await?;
    let status = resp
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    Ok(ExecutionReceipt {
        venue: ExecutionVenue::OpenFinance,
        account: "hyperliquid".to_string(),
        order_id: resp
            .pointer("/response/data/statuses/0/resting")
            .and_then(|v| {
                v.as_u64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(|s| s.to_string()))
            }),
        status: status.to_string(),
        terminal: status == "ok",
        submitted_at_ms: now_ms(),
        raw_status: resp,
    })
}

/// Cancel an order.
pub async fn cancel_order(
    client: &OpenFinanceClient,
    asset_index: usize,
    order_id: &str,
) -> Result<Value> {
    let oid: u64 = order_id.parse().unwrap_or(0);
    let body = json!({
        "cancels": [{ "a": asset_index, "o": oid }]
    });
    client.delete("/orders", &body).await
}

/// Get open orders.
pub async fn get_open_orders(client: &OpenFinanceClient) -> Result<Vec<Value>> {
    let resp = client.get("/orders").await?;
    Ok(resp.as_array().cloned().unwrap_or_default())
}

/// Get fills.
pub async fn get_fills(client: &OpenFinanceClient) -> Result<Vec<Value>> {
    let resp = client.get("/fills").await?;
    Ok(resp.as_array().cloned().unwrap_or_default())
}

// ── Market data ──

/// Get all mid prices.
pub async fn get_mids(client: &OpenFinanceClient) -> Result<Vec<(String, f64)>> {
    let resp = client.get("/../market/mids").await?;
    let mids = resp.as_object().context("mids is not an object")?;
    Ok(mids
        .iter()
        .filter_map(|(k, v)| v.as_str().and_then(|s| s.parse().ok()).map(|p| (k.clone(), p)))
        .collect())
}

/// Get current price for a single asset.
pub async fn get_price(client: &OpenFinanceClient, coin: &str) -> Result<f64> {
    let mids = get_mids(client).await?;
    mids.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(coin))
        .map(|(_, p)| *p)
        .context(format!("no mid price for {coin}"))
}

/// Set leverage for an asset.
pub async fn set_leverage(
    client: &OpenFinanceClient,
    asset_index: usize,
    is_cross: bool,
    leverage: f64,
) -> Result<Value> {
    let body = json!({
        "asset": asset_index,
        "isCross": is_cross,
        "leverage": leverage
    });
    client.post("/leverage", &body).await
}

// ── Helpers ──

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn venue_capabilities() -> VenueCapabilities {
    VenueCapabilities {
        venue: ExecutionVenue::OpenFinance,
        order_kinds: vec![OrderKind::Market, OrderKind::Limit],
        time_in_forces: vec![TimeInForce::Gtc, TimeInForce::Ioc, TimeInForce::Alo],
        reduce_only: true,
        deterministic_order_ids: false,
        delegated_agent_signing: false,
        native_protective_triggers: true,
        native_oco: false,
        native_on_fill: false,
    }
}
