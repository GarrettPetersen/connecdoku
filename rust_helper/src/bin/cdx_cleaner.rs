use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Msg {
    Init {
        categories: HashMap<String, Vec<String>>, // category -> words
        meta_map: HashMap<String, String>,        // category -> meta
    },
    Validate {
        rows: [String; 4],
        cols: [String; 4],
    },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Out {
    Ready,
    Valid,
    Invalid { reason: String },
}

struct State {
    cats: HashMap<String, HashSet<String>>, // category -> word set
    meta: HashMap<String, String>,
}

fn intersect(a: &HashSet<String>, b: &HashSet<String>) -> HashSet<String> {
    if a.len() < b.len() {
        a.iter().filter(|w| b.contains(*w)).cloned().collect()
    } else {
        b.iter().filter(|w| a.contains(*w)).cloned().collect()
    }
}

fn check_meta(rows: &[String;4], cols: &[String;4], state: &State) -> Result<(), String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for c in rows.iter().chain(cols.iter()) {
        if let Some(m) = state.meta.get(c) {
            let e = counts.entry(m.as_str()).or_insert(0);
            *e += 1;
            let max_allowed = if m == "Letter Patterns" { 1 } else { 2 };
            if *e > max_allowed { 
                return Err(format!("Meta-category constraint violated: \"{}\" appears {} times (max {} allowed)", m, *e, max_allowed)); 
            }
        }
    }
    Ok(())
}

fn validate(rows: [String;4], cols: [String;4], state: &State) -> Result<(), String> {
    // existence
    for c in rows.iter().chain(cols.iter()) {
        if !state.cats.contains_key(c) { return Err(format!("Category \"{}\" not found in current word list", c)); }
    }
    // meta
    check_meta(&rows, &cols, state)?;
    // unique cell words
    let all: HashSet<&String> = rows.iter().chain(cols.iter()).collect();
    for r in &rows {
        let rs = &state.cats[r];
        for c in &cols {
            let cs = &state.cats[c];
            let mut inter = intersect(rs, cs);
            for o in &all { if *o != r && *o != c { if let Some(os) = state.cats.get(*o) { inter = inter.drain().filter(|w| !os.contains(w)).collect(); } } }
            if inter.is_empty() { return Err(format!("No unique word exists for cell ({}, {}) - intersection is empty after removing words from other categories", r, c)); }
        }
    }
    Ok(())
}

fn main() {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    let mut state_opt: Option<State> = None;
    let mut stdout = std::io::stdout();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).unwrap();
        if n == 0 { break; }
        let msg: Msg = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Invalid{ reason: format!("bad json: {}", e)}).unwrap()); continue; }
        };
        match msg {
            Msg::Init { categories, meta_map } => {
                let cats = categories.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect();
                let state = State { cats, meta: meta_map };
                state_opt = Some(state);
                let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ready).unwrap());
            }
            Msg::Validate { rows, cols } => {
                if let Some(ref state) = state_opt {
                    match validate(rows, cols, state) {
                        Ok(()) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Valid).unwrap()); }
                        Err(reason) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Invalid{ reason }).unwrap()); }
                    }
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Invalid{ reason: "not initialized".into()}).unwrap());
                }
            }
        }
    }
}


