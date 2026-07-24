// Paper execution simulator for `mlab script run --paper`
// Intercepts ctx.trade() calls and simulates fills with intrabar SL/TP checks.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use anyhow::Result;

use crate::scripting::execution::{
    ScriptExecutionCommand, ScriptOrderRef, ScriptTradeRequest,
    ScriptPositionOperation, ScriptOrderKind,
};
use crate::domain::execution::PositionDirection;

/// Shared paper trading state — persists across onData calls during a single script run.
pub struct PaperState {
    pub capital: f64,
    pub position: Option<PaperPosition>,
    pub trades: Vec<PaperTrade>,
    pub starting_capital: f64,
    pub fee_pct: f64,
}

pub struct PaperPosition {
    pub side: PositionDirection,
    pub entry_price: f64,
    pub size: f64,
    pub margin: f64,
    pub leverage: f64,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub opened_at_ms: u64,
    pub bars_held: usize,
    pub order_key: String,
    pub entry_candle_t: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PaperTrade {
    pub side: String,
    pub entry: f64,
    pub exit: f64,
    pub pnl_pct: f64,
    pub net_pnl_pct: f64,
    pub pnl_usd: f64,
    pub reason: String,
    pub bars_held: usize,
    pub entry_time_ms: u64,
    pub exit_time_ms: u64,
}

impl PaperState {
    pub fn new(capital: f64, fee_pct: f64) -> Self {
        Self {
            starting_capital: capital,
            capital,
            position: None,
            trades: Vec::new(),
            fee_pct,
        }
    }

    /// Process a trade request from the strategy script.
    pub fn process_trade(&mut self, order: &ScriptOrderRef, request: &ScriptTradeRequest) -> Result<()> {
        if request.position.is_open() {
            if self.position.is_some() {
                return Ok(());
            }

            let leverage = request.leverage_or_default();
            // For market orders, use the order price or 0 (strategy provides price in ctx.trade)
            let ref_price = match request.order.kind {
                ScriptOrderKind::Market => request.order.price.unwrap_or(0.0),
                ScriptOrderKind::Limit => request.order.price.unwrap_or(0.0),
            };

            let (size, margin) = match (request.size, request.margin) {
                (Some(sz), _) => (sz, sz * ref_price / leverage),
                (_, Some(mgn)) => {
                    if ref_price > 0.0 {
                        (mgn * leverage / ref_price, mgn)
                    } else {
                        (0.0, mgn)
                    }
                }
                _ => return Ok(()),
            };

            let entry_price = match request.order.kind {
                ScriptOrderKind::Market => ref_price,
                ScriptOrderKind::Limit => request.order.price.unwrap_or(ref_price),
            };

            self.position = Some(PaperPosition {
                side: if request.position == ScriptPositionOperation::OpenLong {
                    PositionDirection::Long
                } else {
                    PositionDirection::Short
                },
                entry_price,
                size,
                margin,
                leverage,
                stop_loss: request.sl,
                take_profit: request.tp,
                opened_at_ms: 0,
                bars_held: 0,
                order_key: order.key.clone(),
                entry_candle_t: 0,
            });
        } else {
            // Closing — mark for close at current price
            // The close happens immediately since we don't have a "next candle" in paper mode
            if self.position.is_some() {
                let entry = self.position.as_ref().unwrap().entry_price;
                self.close_position(entry, "strategy_close");
            }
        }

        Ok(())
    }

    /// Check exits against a completed candle's high/low (intrabar simulation).
    pub fn check_exits_intrabar(&mut self, candle_high: f64, candle_low: f64) -> bool {
        let pos = match &self.position {
            Some(p) => p,
            None => return false,
        };

        let entry = pos.entry_price;
        let side = pos.side;

        // Check SL using candle extreme (intrabar wick)
        if let Some(sl) = pos.stop_loss {
            match side {
                PositionDirection::Long => {
                    if candle_low <= sl {
                        self.close_position(sl, "stop_loss_intrabar");
                        return true;
                    }
                }
                PositionDirection::Short => {
                    if candle_high >= sl {
                        self.close_position(sl, "stop_loss_intrabar");
                        return true;
                    }
                }
            }
        }

        // Check TP using candle extreme
        if let Some(tp) = pos.take_profit {
            match side {
                PositionDirection::Long => {
                    if candle_high >= tp {
                        self.close_position(tp, "take_profit_intrabar");
                        return true;
                    }
                }
                PositionDirection::Short => {
                    if candle_low <= tp {
                        self.close_position(tp, "take_profit_intrabar");
                        return true;
                    }
                }
            }
        }

        false
    }

    /// Increment bar counter for the open position.
    pub fn tick_bar(&mut self) {
        if let Some(pos) = &mut self.position {
            pos.bars_held += 1;
        }
    }

    /// Force close at current price.
    pub fn close_position(&mut self, price: f64, reason: &str) {
        self.close_position_at(price, reason, 0);
    }

    /// Force close at current price with exit timestamp.
    pub fn close_position_at(&mut self, price: f64, reason: &str, exit_time_ms: u64) {
        let pos = match self.position.take() {
            Some(p) => p,
            None => return,
        };

        let pnl_pct = match pos.side {
            PositionDirection::Long => (price - pos.entry_price) / pos.entry_price * 100.0,
            PositionDirection::Short => (pos.entry_price - price) / pos.entry_price * 100.0,
        };

        let net_pnl = pnl_pct - 2.0 * self.fee_pct;
        let pnl_usd = pos.margin * net_pnl / 100.0;

        self.capital += pnl_usd;

        self.trades.push(PaperTrade {
            side: format!("{:?}", pos.side).to_lowercase(),
            entry: pos.entry_price,
            exit: price,
            pnl_pct,
            net_pnl_pct: net_pnl,
            pnl_usd,
            reason: reason.to_string(),
            bars_held: pos.bars_held,
            entry_time_ms: pos.entry_candle_t,
            exit_time_ms,
        });
    }

    /// Get unrealized PnL at current price.
    pub fn unrealized_pnl(&self, price: f64) -> Option<f64> {
        self.position.as_ref().map(|pos| {
            let pnl = match pos.side {
                PositionDirection::Long => (price - pos.entry_price) / pos.entry_price * 100.0,
                PositionDirection::Short => (pos.entry_price - price) / pos.entry_price * 100.0,
            };
            pnl - 2.0 * self.fee_pct
        })
    }

    /// Summary stats for output.
    pub fn stats(&self) -> Value {
        let wins = self.trades.iter().filter(|t| t.net_pnl_pct > 0.0).count();
        let total = self.trades.len();
        let wr = if total > 0 { wins as f64 / total as f64 } else { 0.0 };
        let total_pnl: f64 = self.trades.iter().map(|t| t.pnl_usd).sum();

        json!({
            "starting_capital": self.starting_capital,
            "capital": self.capital,
            "trades": total,
            "wins": wins,
            "win_rate": wr,
            "total_pnl_usd": total_pnl,
            "open_position": self.position.as_ref().map(|p| {
                json!({
                    "side": format!("{:?}", p.side).to_lowercase(),
                    "entry": p.entry_price,
                    "size": p.size,
                    "margin": p.margin,
                    "leverage": p.leverage,
                    "stop_loss": p.stop_loss,
                    "take_profit": p.take_profit,
                    "bars_held": p.bars_held,
                })
            }),
        })
    }
}
