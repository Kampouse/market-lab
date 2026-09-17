//! `arb bridge` — live on-chain scan → lisp-rlm arb brain on near-mock.
//!
//! Pipeline:
//!   1. fetch on-chain Ref pools (xy=k) — the only legs a NEAR contract can walk
//!      (Binance legs are radar-only: a contract cannot fetch HTTP)
//!   2. Bellman-Ford over that graph (`arb::find_cycle`)
//!   3. mirror the cycle's pools into the mock DEX with LIVE reserves (µ-scaled)
//!   4. scout quotes each leg through the mock at cap → expected integer rates
//!      (same convention as the near-mock rehearsal: raw out×10⁴/in)
//!   5. `configure` the brain; `--fire` → `run()` + status
//!
//! Trust story preserved end-to-end: the brain still verifies economics itself
//! (integer cycle gate + per-leg min_out guards) — a mirror that lies, or a
//! market that moved between snapshot and fire, gets trapped, not traded.
//!
//! near-mock binary is expected at ~/dev/lisp-rlm/target/release/near-mock
//! (the lisp-rlm release build emits it alongside the compiler).

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::commands::arb::{find_cycle, Pool};
use crate::commands::arb_live::{fetch_ref_pool, http};

pub(crate) struct BridgeCfg {
    pub(crate) capital: i64,
    pub(crate) brain: String,
    pub(crate) dex: String,
    pub(crate) state: PathBuf,
    pub(crate) dex_wasm: PathBuf,
    pub(crate) brain_wasm: PathBuf,
    pub(crate) tol_bps: i64,
    pub(crate) min_edge_bps: i64,
    pub(crate) fire: bool,
}

struct Leg {
    key: String,
    base: String,
    quote: String,
    fee_bps: i64,
    r_base_micro: i64,
    r_quote_micro: i64,
    /// true = cycle input is the pool's base token (dex side "base")
    sell: bool,
}

fn side_of(l: &Leg) -> &'static str {
    if l.sell {
        "base"
    } else {
        "quote"
    }
}

/// One near-mock cross call; returns the contract's 📄 return value.
fn nm_call(
    nm: &Path,
    state: &str,
    man: &str,
    acct: &str,
    method: &str,
    args: &str,
) -> Result<String> {
    let out = Command::new(nm)
        .args(["cross", state, man, acct, method, args])
        .output()
        .with_context(|| format!("spawn near-mock {acct}.{method}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("📄 ") {
            return Ok(rest.trim().to_string());
        }
    }
    bail!(
        "near-mock {acct}.{method} returned nothing\nstdout: {}\nstderr: {}",
        stdout.trim(),
        String::from_utf8_lossy(&out.stderr).trim()
    );
}

pub(crate) async fn handle(ref_ids: Vec<u64>, _binance_ignored: Vec<String>, cfg: BridgeCfg) -> Result<()> {
    println!("== mlab → on-chain brain bridge ==");

    // ── 1. fetch on-chain pools ────────────────────────────────────────────
    let client = http()?;
    let mut meta = HashMap::new();
    let mut fetched = 0usize;
    let mut pools: Vec<Pool> = Vec::new();
    for id in &ref_ids {
        match fetch_ref_pool(&client, *id, &mut meta).await {
            // NOTE: no pair-dedupe — twin pools (same pair, different id) are
            // exactly where twin-pool arb lives
            Ok(p) => {
                fetched += 1;
                pools.push(p);
            }
            Err(e) => println!("  skip ref{id}: {e:#}"),
        }
    }
    println!("on-chain pools: {fetched} fetched, {} usable", pools.len());
    if pools.len() < 3 {
        bail!("need ≥3 on-chain pools to form a cycle");
    }

    // ── 2. find + orient the cycle ─────────────────────────────────────────
    let Some(cycle) = find_cycle(&pools)? else {
        println!("no on-chain cycle — nothing to bridge");
        return Ok(());
    };
    let mut cycle = cycle;
    for want in ["USDC", "USDT"] {
        if let Some(i) = cycle.edges.iter().position(|e| e.from == want) {
            cycle.edges.rotate_left(i);
            break;
        }
    }
    let path_str = cycle
        .edges
        .iter()
        .map(|e| e.from.as_str())
        .chain(std::iter::once(cycle.edges[0].from.as_str()))
        .collect::<Vec<_>>()
        .join("→");
    let marginal_bps = (cycle.factor - 1.0) * 10_000.0;
    println!("cycle: {path_str} (marginal {marginal_bps:+.1} bps)");
    if cycle.edges.len() != 2 && cycle.edges.len() != 3 {
        bail!(
            "brain (examples/arb_live.ts) supports 2-leg (twin-pool) or 3-leg \
             cycles; found {}-leg cycle: {path_str}",
            cycle.edges.len()
        );
    }

    // ── 3. resolve legs → mock-dex pool specs with live reserves ──────────
    let mut legs: Vec<Leg> = Vec::new();
    for e in &cycle.edges {
        let p = pools
            .iter()
            .find(|p| p.id == e.pool)
            .with_context(|| format!("edge pool {} missing", e.pool))?;
        if e.from != p.base && e.from != p.quote {
            bail!("edge {} inconsistent with pool {}", e.from, p.id);
        }
        let (rb, rq) = p
            .cprod
            .with_context(|| format!("{}: no constant-product reserves", p.id))?;
        if p.fee_bps.fract() != 0.0 {
            bail!(
                "{}: fractional fee {} bps unsupported by the mock dex",
                p.id,
                p.fee_bps
            );
        }
        let r_base_micro = (rb * 1e6).round() as i64;
        let r_quote_micro = (rq * 1e6).round() as i64;
        if r_base_micro <= 0 || r_quote_micro <= 0 {
            bail!("{}: reserves round to zero at µ scale", p.id);
        }
        legs.push(Leg {
            key: p.id.clone(), // twins (BANANA/NEAR ×2) must stay distinct pools
            base: p.base.clone(),
            quote: p.quote.clone(),
            fee_bps: p.fee_bps as i64,
            r_base_micro,
            r_quote_micro,
            sell: e.from == p.base,
        });
        println!(
            "  leg{}: {} → {}  pool {} ({})  reserves {:.2}/{:.2}  fee {}bps  side {}",
            legs.len() - 1,
            e.from,
            e.to,
            p.id,
            p.venue,
            rb,
            rq,
            p.fee_bps,
            side_of(legs.last().unwrap())
        );
    }

    // ── 4. mirror into the mock dex on near-mock ──────────────────────────
    let home = std::env::var("HOME").context("HOME unset")?;
    let nm = PathBuf::from(home)
        .join("dev/lisp-rlm/target/release/near-mock");
    if !nm.exists() {
        bail!("near-mock binary missing: {}", nm.display());
    }
    let man = format!(
        "{0}={1},{2}={3}",
        cfg.dex,
        cfg.dex_wasm.display(),
        cfg.brain,
        cfg.brain_wasm.display()
    );
    let st = cfg.state.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&cfg.state); // fresh state each bridge run

    println!("== mock dex ← live reserves (µ-scale) ==");
    for l in &legs {
        nm_call(
            &nm,
            &st,
            &man,
            &cfg.dex,
            "init",
            &format!(
                "{{\"key\":\"{}\",\"base\":\"{}\",\"quote\":\"{}\",\"fee_bps\":{}}}",
                l.key, l.base, l.quote, l.fee_bps
            ),
        )?;
        nm_call(
            &nm,
            &st,
            &man,
            &cfg.dex,
            "fund",
            &format!(
                "{{\"key\":\"{}\",\"side\":\"base\",\"amount\":{}}}",
                l.key, l.r_base_micro
            ),
        )?;
        nm_call(
            &nm,
            &st,
            &man,
            &cfg.dex,
            "fund",
            &format!(
                "{{\"key\":\"{}\",\"side\":\"quote\",\"amount\":{}}}",
                l.key, l.r_quote_micro
            ),
        )?;
        println!(
            "  {} funded: {} µ{} / {} µ{}",
            l.key, l.r_base_micro, l.base, l.r_quote_micro, l.quote
        );
    }

    // ── 5. scout: size ladder — find the largest size where the depth-checked
    // cycle still clears the gate (marginal edge ≠ executable edge). ────────
    println!(
        "== scout: size ladder from {} µ{entry} ==",
        cfg.capital,
        entry = cycle.edges[0].from
    );
    let sc: i64 = 1_000_000;
    let threshold = sc + cfg.min_edge_bps * 100;
    let mut best: Option<(i64, Vec<i64>, i64)> = None; // (size, rates, final_out)
    let mut size = cfg.capital;
    while size >= 100 {
        let mut amt = size;
        let mut rates: Vec<i64> = Vec::new();
        let mut ok = true;
        for l in legs.iter() {
            let ret = nm_call(
                &nm,
                &st,
                &man,
                &cfg.dex,
                "quote",
                &format!(
                    "{{\"key\":\"{}\",\"side\":\"{}\",\"amount\":{}}}",
                    l.key,
                    side_of(l),
                    amt
                ),
            )?;
            let out: i64 = ret.trim().parse().unwrap_or(0);
            if out <= 0 {
                ok = false;
                break;
            }
            rates.push(out * 1_000_000 / amt);
            amt = out;
        }
        if ok {
            let exp = if legs.len() == 2 {
                rates[0] * rates[1] / sc
            } else {
                (rates[0] * rates[1] / sc) * rates[2] / sc
            };
            println!(
                "  size {:>9} µ{entry} → {amt} out, edge {:+} bps{check}",
                size,
                (exp - sc) / 100,
                check = if exp >= threshold { " ✓" } else { "" },
                entry = cycle.edges[0].from,
            );
            if exp >= threshold {
                best = Some((size, rates, amt));
                break; // descending ladder: first clear is the largest clear
            }
        } else {
            println!("  size {size:>9} µ: unexecutable (dex guard hit)");
        }
        size /= 2;
    }

    let Some((size, rates, final_out)) = best else {
        println!(
            "no size ≥100 µ clears min_edge {} bps — cycle exists but is not \
             executable within depth; nothing configured",
            cfg.min_edge_bps
        );
        return Ok(());
    };
    let rates_str = rates
        .iter()
        .enumerate()
        .map(|(i, r)| format!("r{i}={r}"))
        .collect::<Vec<_>>()
        .join(" ");
    println!(
        "chosen: {size} µ{entry} ({rates_str}) → {final_out} out",
        entry = cycle.edges[0].from
    );

    // ── 6. configure (and optionally fire) the brain ──────────────────────
    // 2-leg mode: slot 2 carries neutral placeholders (brain ignores them)
    let (c2, d2, r2v) = if legs.len() == 3 {
        (legs[2].key.as_str(), side_of(&legs[2]), rates[2])
    } else {
        ("x", "base", 1)
    };
    let conf = format!(
        "{{\"dex\":\"{}\",\"c0\":\"{}\",\"d0\":\"{}\",\"r0\":{},\
         \"c1\":\"{}\",\"d1\":\"{}\",\"r1\":{},\
         \"c2\":\"{}\",\"d2\":\"{}\",\"r2\":{},\
         \"cap\":{},\"tol_bps\":{},\"min_edge_bps\":{},\"nlegs\":{}}}",
        cfg.dex,
        legs[0].key,
        side_of(&legs[0]),
        rates[0],
        legs[1].key,
        side_of(&legs[1]),
        rates[1],
        c2,
        d2,
        r2v,
        size,
        cfg.tol_bps,
        cfg.min_edge_bps,
        legs.len()
    );
    let ret = nm_call(&nm, &st, &man, &cfg.brain, "configure", &conf)?;
    println!("configure → {ret}");

    if cfg.fire {
        let ret = nm_call(&nm, &st, &man, &cfg.brain, "run", "{}")?;
        println!("run → {ret}");
        let status = nm_call(&nm, &st, &man, &cfg.brain, "status", "{}")?;
        println!("status → {status}");
        if ret.starts_with("FIRED") {
            let pos: i64 = status
                .split_whitespace()
                .find_map(|t| t.strip_prefix("pos:").map(|v| v.to_string()))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let delta = pos - size;
            println!(
                "realized: {size} → {pos} µ{} ({delta:+} µ, {:+.1} bps)",
                cycle.edges[0].from,
                delta as f64 * 10_000.0 / size as f64
            );
        }
    } else {
        println!("(dry run — pass --fire to execute)");
    }
    Ok(())
}
