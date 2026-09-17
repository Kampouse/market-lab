use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::cli::{ArbArgs, ArbCommands};

pub fn handle(args: ArbArgs) -> Result<()> {
    match args.command {
        ArbCommands::Sample { out } => cmd_sample(&out),
        ArbCommands::Scan { file, capital } => cmd_scan(&file, capital),
        other => unreachable!("sync arb commands exhausted: {other:?}"),
    }
}

/// Dispatch used by main (async: `arb live` fetches real market data).
pub async fn handle_async(args: ArbArgs) -> Result<()> {
    match args.command {
        ArbCommands::Live {
            pools,
            binance,
            capital,
            out,
        } => {
            crate::commands::arb_live::handle(pools, binance, capital, out).await?;
            Ok(())
        }
        other => handle(ArbArgs { command: other }),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct Pool {
    pub(crate) id: String,
    pub(crate) venue: String,
    pub(crate) base: String,
    pub(crate) quote: String,
    pub(crate) bid: f64,
    pub(crate) ask: f64,
    pub(crate) fee_bps: f64,
    /// constant-product depth in human units: (r_base, r_quote). None = book/marginal.
    #[serde(default)]
    pub(crate) cprod: Option<(f64, f64)>,
    /// order-book top depth in base units: (bid_qty, ask_qty). None = no cap known.
    #[serde(default)]
    pub(crate) book_qty: Option<(f64, f64)>,
}

struct Edge {
    from: String,
    to: String,
    rate: f64,
    pool: String,
    venue: String,
    side: &'static str,
    px: f64,
}

fn cmd_sample(out: &Path) -> Result<()> {
    let pools = vec![
        Pool {
            id: "p0".into(),
            venue: "okx".into(),
            base: "wETH".into(),
            quote: "wUSD".into(),
            bid: 3001.0,
            ask: 3002.0,
            fee_bps: 1.0,
            cprod: None,
            book_qty: None,
        },
        Pool {
            id: "p1".into(),
            venue: "binance".into(),
            base: "wBTC".into(),
            quote: "wETH".into(),
            bid: 19.5,
            ask: 19.6,
            fee_bps: 2.0,
            cprod: None,
            book_qty: None,
        },
        Pool {
            id: "p2".into(),
            venue: "kraken".into(),
            base: "wBTC".into(),
            quote: "wUSD".into(),
            bid: 58200.0,
            ask: 58400.0,
            fee_bps: 2.0,
            cprod: None,
            book_qty: None,
        },
    ];
    fs::write(out, serde_json::to_string_pretty(&pools)?)?;
    println!("wrote {} pools → {}", pools.len(), out.display());
    Ok(())
}

fn cmd_scan(file: &Path, capital: f64) -> Result<()> {
    let raw = fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?;
    let pools: Vec<Pool> = serde_json::from_str(&raw)?;
    scan_pools(&pools, capital)
}

/// Execute one hop at size `x` (in `from` units), honoring depth:
///   - cprod pools: exact constant-product (sell: x·f·r_q/(r_b+x·f); buy via k-invariant)
///   - book pools: marginal price capped at top-of-book qty (x beyond cap = unreachable)
///   - synthetic: flat rate, no cap
/// Direction is derived from the edge itself (pool matches base/from-quote).
pub(crate) fn exec_hop(p: &Pool, sell: bool, x: f64) -> f64 {
    let f = 1.0 - p.fee_bps / 10_000.0;
    match (p.cprod, p.book_qty) {
        (Some((rb, rq)), _) => {
            if sell {
                x * f * rq / (rb + x * f)
            } else {
                rb * (x * f) / (rq + x * f)
            }
        }
        (None, Some((bid_qty, ask_qty))) => {
            // caps are in BASE units; x is in `from` units, so convert buys first
            if sell {
                if x > bid_qty {
                    f64::NAN // beyond known top-of-book depth: unexecutable at this size
                } else {
                    x * p.bid * f
                }
            } else {
                let base_in = x / p.ask;
                if base_in > ask_qty {
                    f64::NAN
                } else {
                    base_in * f
                }
            }
        }
        (None, None) => {
            if sell {
                x * p.bid * f
            } else {
                x / p.ask * f
            }
        }
    }
}

/// Shared Bellman-Ford negative-cycle scan over a pool set.
pub(crate) fn scan_pools(pools: &[Pool], capital: f64) -> Result<()> {
    // Edges (price = quote per base):
    //   base→quote: sell base at bid   → rate = bid·(1-fee)
    //   quote→base: buy base at ask    → rate = (1-fee)/ask
    let mut edges: Vec<Edge> = Vec::new();
    for p in pools {
        let f = 1.0 - p.fee_bps / 10_000.0;
        edges.push(Edge {
            from: p.base.clone(),
            to: p.quote.clone(),
            rate: p.bid * f,
            pool: p.id.clone(),
            venue: p.venue.clone(),
            side: "sell",
            px: p.bid,
        });
        edges.push(Edge {
            from: p.quote.clone(),
            to: p.base.clone(),
            rate: f / p.ask,
            pool: p.id.clone(),
            venue: p.venue.clone(),
            side: "buy",
            px: p.ask,
        });
    }

    // Node indexing in first-appearance order (deterministic).
    let mut names: Vec<String> = Vec::new();
    let mut idx: HashMap<String, usize> = HashMap::new();
    for e in &edges {
        for node in [&e.from, &e.to] {
            if !idx.contains_key(node) {
                idx.insert(node.clone(), names.len());
                names.push(node.clone());
            }
        }
    }
    let n = names.len();

    // Bellman-Ford from a virtual source (dist=0 everywhere): a negative
    // total-weight cycle ⇔ a product-of-rates > 1 arbitrage cycle.
    let mut dist = vec![0.0f64; n];
    let mut pe = vec![usize::MAX; n]; // edge used to reach each node
    let mut hit = usize::MAX;
    for iter in 0..=n {
        let mut improved = false;
        for (ei, e) in edges.iter().enumerate() {
            let u = idx[&e.from];
            let v = idx[&e.to];
            let w = -e.rate.ln();
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pe[v] = ei;
                improved = true;
                if iter == n {
                    hit = v;
                }
            }
        }
        if !improved {
            println!(
                "no arbitrage: {} pools, {} edges, graph clean",
                pools.len(),
                edges.len()
            );
            return Ok(());
        }
    }
    ensure!(hit != usize::MAX, "relaxed {} iters with no cycle", n);

    // Extract the cycle: n predecessor-steps from the hit node land inside it.
    let mut cur = hit;
    for _ in 0..n {
        let e = pe[cur];
        ensure!(e != usize::MAX, "cycle walk hit root");
        cur = idx[&edges[e].from];
    }
    let start = cur;
    let mut cedges: Vec<usize> = Vec::new();
    loop {
        let e = pe[cur];
        cedges.push(e);
        cur = idx[&edges[e].from];
        if cur == start {
            break;
        }
    }
    cedges.reverse();

    // Deterministic rotation: start at the highest-index node.
    let (mut bp, mut bi) = (0, 0);
    for (pos, &ei) in cedges.iter().enumerate() {
        let id = idx[&edges[ei].from];
        if id > bi {
            bi = id;
            bp = pos;
        }
    }
    cedges.rotate_left(bp);

    let mut factor = 1.0;
    let mut exec = capital;
    let mut exec_ok = true;
    println!("BEST CYCLE:");
    for &ei in &cedges {
        let e = &edges[ei];
        factor *= e.rate;
        if let Some(p) = pools.iter().find(|p| p.id == e.pool) {
            if exec_ok {
                let out = exec_hop(p, e.side == "sell", exec);
                if out.is_nan() {
                    exec_ok = false;
                } else {
                    exec = out;
                }
            }
        }
        println!(
            "  {:<5} → {:<5} pool {} ({:<7}) {} @ {:<12} rate {:.6}",
            e.from, e.to, e.pool, e.venue, e.side, e.px, e.rate
        );
    }
    let bps = (factor - 1.0) * 10_000.0;
    println!("gross factor {:.6}  marginal {:+.1} bps", factor, bps);
    let cur = &edges[cedges[0]].from;
    if exec_ok {
        println!(
            "  depth-checked: {:.2} {} → {:.2} {} ({:+.1} bps real)",
            capital,
            cur,
            exec,
            cur,
            (exec / capital - 1.0) * 10_000.0
        );
    } else {
        println!(
            "  NOT executable at {:.2} {}: exceeds known top-of-book depth",
            capital, cur
        );
    }
    Ok(())
}
