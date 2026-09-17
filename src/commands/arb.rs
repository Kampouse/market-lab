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
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Pool {
    id: String,
    venue: String,
    base: String,
    quote: String,
    bid: f64,
    ask: f64,
    fee_bps: f64,
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
        },
        Pool {
            id: "p1".into(),
            venue: "binance".into(),
            base: "wBTC".into(),
            quote: "wETH".into(),
            bid: 19.5,
            ask: 19.6,
            fee_bps: 2.0,
        },
        Pool {
            id: "p2".into(),
            venue: "kraken".into(),
            base: "wBTC".into(),
            quote: "wUSD".into(),
            bid: 58200.0,
            ask: 58400.0,
            fee_bps: 2.0,
        },
    ];
    fs::write(out, serde_json::to_string_pretty(&pools)?)?;
    println!("wrote {} pools → {}", pools.len(), out.display());
    Ok(())
}

fn cmd_scan(file: &Path, capital: f64) -> Result<()> {
    let raw = fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?;
    let pools: Vec<Pool> = serde_json::from_str(&raw)?;

    // Edges (price = quote per base):
    //   base→quote: sell base at bid   → rate = bid·(1-fee)
    //   quote→base: buy base at ask    → rate = (1-fee)/ask
    let mut edges: Vec<Edge> = Vec::new();
    for p in &pools {
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
    println!("BEST CYCLE:");
    for &ei in &cedges {
        let e = &edges[ei];
        factor *= e.rate;
        println!(
            "  {:<5} → {:<5} pool {} ({:<7}) {} @ {:<9} rate {:.6}",
            e.from, e.to, e.pool, e.venue, e.side, e.px, e.rate
        );
    }
    let bps = (factor - 1.0) * 10_000.0;
    println!(
        "gross factor {:.6}  net {:+.1} bps  on {} → {:.2}",
        factor,
        bps,
        capital,
        capital * factor
    );
    Ok(())
}
