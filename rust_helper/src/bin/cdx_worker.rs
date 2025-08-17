use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Msg {
    Init {
        masks: Vec<Vec<u32>>, // bitsets per category
        n1: Vec<Vec<usize>>,  // adjacency 1-away
        n2: Vec<Vec<usize>>,  // adjacency 2-away
        categories: Vec<String>,
        meta_map: Vec<Option<String>>, // meta per category index (or None)
        write_mode: Option<String>, // None or Some("rust")
        db_path: Option<String>,
        word_list_hash: Option<String>,
    },
    Work {
        start: usize,
        end: usize,
        jStart: Option<usize>,
        jEnd: Option<usize>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Out {
    Ready,
    Tick { jProgress: usize, totalJ: usize },
    Found { rows: [usize; 4], cols: [usize; 4] },
    Stats { found: usize, inserted: usize },
    Done { totalJ: usize },
    Error { message: String },
}

struct State {
    masks: Vec<Vec<u32>>, // immutable
    n1: Vec<Vec<usize>>,  // sorted
    n2: Vec<Vec<usize>>,  // sorted
    categories: Vec<String>,
    meta_map: Vec<Option<String>>, // same length as categories
    subset: Vec<Vec<bool>>, // S[i][j]
    write_mode: bool,
    db: Option<rusqlite::Connection>,
    word_list_hash: Option<String>,
}

fn intersects(a: &[u32], b: &[u32]) -> bool {
    a.iter().zip(b.iter()).any(|(x, y)| (x & y) != 0)
}

fn subset(a: &[u32], b: &[u32]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x & !y) == 0)
}

fn check_meta_constraint(rows: &[usize; 4], cols: &[usize; 4], state: &State) -> bool {
    use std::collections::HashMap;
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for &idx in rows.iter().chain(cols.iter()) {
        if let Some(ref m) = state.meta_map[idx] {
            let e = counts.entry(m.as_str()).or_insert(0);
            *e += 1;
            if *e > 2 { return false; }
        }
    }
    true
}

fn check_rows_meta(rows: &[usize; 4], state: &State) -> bool {
    use std::collections::HashMap;
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for &idx in rows.iter() {
        if let Some(ref m) = state.meta_map[idx] {
            let e = counts.entry(m.as_str()).or_insert(0);
            *e += 1;
            if *e > 2 { return false; }
        }
    }
    true
}

fn excl(rows: &[usize; 4], state: &State) -> bool {
    // mirrors JS excl
    let mask = &state.masks;
    let mask_len = mask[0].len();
    for r in 0..4 {
        let m = &mask[rows[r]];
        let mut other = vec![0u32; mask_len];
        for o in 0..4 {
            if o == r { continue; }
            for k in 0..mask_len { other[k] |= mask[rows[o]][k]; }
        }
        let mut ok = false;
        for k in 0..mask_len {
            if (m[k] & !other[k]) != 0 { ok = true; break; }
        }
        if !ok { return false; }
    }
    true
}

fn run_work_streaming<W: Write>(state: &State, start: usize, end: usize, j_start: Option<usize>, j_end: Option<usize>, writer: &mut W) {
    let _n = state.masks.len();
    let mask_len = state.masks[0].len();

    let mut found_count: usize = 0;
    let mut inserted_count: usize = 0;
    for i in start..end {
        let mut j_list: Vec<usize> = state.n2[i].iter().copied().filter(|&j| j > i).collect();
        j_list.sort_unstable();

        let mut total_j = j_list.len();
        let (mut ps, mut pe) = (0usize, total_j);
        if let (Some(s), Some(e)) = (j_start, j_end) {
            let s = s.min(total_j);
            let e = e.min(total_j).max(s);
            total_j = e - s;
            ps = s; pe = e;
        }
        let mut j_progress = 0usize;

        for jj in ps..pe {
            let j = j_list[jj];

            // Build k list
            let mut k_list: Vec<usize> = state.n2[i].iter().copied().filter(|&k| k > j && state.n2[j].binary_search(&k).is_ok()).collect();
            // note: n2[j] not guaranteed sorted, ensure sorted once
            k_list.sort_unstable();

            for &k in &k_list {
                // l list
                let mut l_list: Vec<usize> = k_list.iter().copied().filter(|&l| l > k && state.n2[k].binary_search(&l).is_ok()).collect();
                l_list.sort_unstable();
                for &l in &l_list {
                    let rows = [i, j, k, l];
                    if !excl(&rows, state) { continue; }
                    if !check_rows_meta(&rows, state) { continue; }

                    // meta constraint rows
                    if !check_meta_constraint(&rows, &[0,0,0,0], state) { /* cols unknown here; handled later as full set */ }

                    // column candidates
                    let mut cand: Vec<usize> = state.n1[i].clone();
                    cand.sort_unstable();
                    for r in 1..4 {
                        let nr = &state.n1[rows[r]];
                        let mut tmp = Vec::with_capacity(cand.len());
                        let mut a=0usize; let mut b=0usize;
                        let mut sorted_nr = nr.clone();
                        sorted_nr.sort_unstable();
                        while a < cand.len() && b < sorted_nr.len() {
                            if cand[a] == sorted_nr[b] { tmp.push(cand[a]); a+=1; b+=1; }
                            else if cand[a] < sorted_nr[b] { a+=1; } else { b+=1; }
                        }
                        cand = tmp;
                    }
                    cand.retain(|c| !rows.iter().any(|r| r == c));
                    // filter by subset matrix like JS: remove c if any S[r][c] is true
                    cand.retain(|&c| !rows.iter().any(|&r| state.subset[r][c]));
                    if cand.len() < 4 || cand.iter().min().copied().unwrap_or(usize::MAX) <= rows[0] { continue; }

                    let mut c_arr = cand.clone();
                    c_arr.sort_unstable();
                    let m = c_arr.len();
                    for a in 0..m.saturating_sub(3) {
                        for b in (a+1)..m.saturating_sub(2) {
                            let x = c_arr[a]; let y = c_arr[b];
                            if !state.n2[x].binary_search(&y).is_ok() { continue; }
                            for c in (b+1)..m.saturating_sub(1) {
                                let z = c_arr[c];
                                if !(state.n2[x].binary_search(&z).is_ok() && state.n2[y].binary_search(&z).is_ok()) { continue; }
                                for d in (c+1)..m {
                                    let w = c_arr[d];
                                    if !(state.n2[x].binary_search(&w).is_ok() && state.n2[y].binary_search(&w).is_ok() && state.n2[z].binary_search(&w).is_ok()) { continue; }
                                    let cols = [x,y,z,w];

                                    // meta constraint full set
                                    if !check_meta_constraint(&rows, &cols, state) { continue; }

                                    // full uniqueness check
                                    let mut ok = true;
                                    let mut all = rows.to_vec(); all.extend_from_slice(&cols);
                                    for &r in &rows {
                                        for &cc in &cols {
                                            let mut own: Vec<u32> = (0..mask_len).map(|k| state.masks[r][k] & state.masks[cc][k]).collect();
                                            for &o in &all { if o != r && o != cc { for k in 0..mask_len { own[k] &= !state.masks[o][k]; } } }
                                            if !own.iter().any(|&x| x != 0) { ok = false; break; }
                                        }
                                        if !ok { break; }
                                    }
                                    if !ok { continue; }

                                    if state.write_mode {
                                        if let Some(ref db) = state.db {
                                            let sql = "INSERT OR IGNORE INTO puzzles (puzzle_hash,row0,row1,row2,row3,col0,col1,col2,col3,word_list_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)";
                                            let rows_cats: Vec<&str> = rows.iter().map(|&idx| state.categories[idx].as_str()).collect();
                                            let cols_cats: Vec<&str> = cols.iter().map(|&idx| state.categories[idx].as_str()).collect();
                                            use sha2::{Digest, Sha256};
                                            let mut hasher = Sha256::new();
                                            hasher.update(rows_cats.join("|").as_bytes());
                                            hasher.update(cols_cats.join("|").as_bytes());
                                            let hash = hex::encode(hasher.finalize());
                                            if let Some(ref wlh) = state.word_list_hash {
                                                let _ = db.execute(sql, (
                                                    &hash,
                                                    rows_cats[0], rows_cats[1], rows_cats[2], rows_cats[3],
                                                    cols_cats[0], cols_cats[1], cols_cats[2], cols_cats[3],
                                                    wlh,
                                                ));
                                                inserted_count += 1; // approximate; ignore IGNORE status for speed
                                            }
                                        }
                                        found_count += 1;
                                    } else {
                                        let _ = writeln!(writer, "{}", serde_json::to_string(&Out::Found { rows, cols }).unwrap());
                                        found_count += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            j_progress += 1;
            if j_progress % 2 == 0 || j_progress == total_j {
                let _ = writeln!(writer, "{}", serde_json::to_string(&Out::Tick { jProgress: j_progress, totalJ: total_j }).unwrap());
            }
        }
        if total_j == 0 || j_progress != total_j {
            let _ = writeln!(writer, "{}", serde_json::to_string(&Out::Tick { jProgress: total_j, totalJ: total_j }).unwrap());
        }
    }
    if state.write_mode {
        let _ = writeln!(writer, "{}", serde_json::to_string(&Out::Stats { found: found_count, inserted: inserted_count }).unwrap());
    }
    let _ = writeln!(writer, "{}", serde_json::to_string(&Out::Done { totalJ: 0 }).unwrap());
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
            Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("bad json: {}", e)}).unwrap()); continue; }
        };
        match msg {
            Msg::Init { masks, mut n1, mut n2, categories, meta_map, write_mode, db_path, word_list_hash } => {
                // sort adjacency for binary_search
                for v in &mut n1 { v.sort_unstable(); }
                for v in &mut n2 { v.sort_unstable(); }
                // compute subset matrix S
                let ncat = masks.len();
                let mut subset = vec![vec![false; ncat]; ncat];
                for i in 0..ncat {
                    for j in 0..ncat {
                        if i==j { continue; }
                        let a_sub_b = masks[i].iter().zip(&masks[j]).all(|(a,b)| (a & !b) == 0);
                        if a_sub_b { subset[i][j] = true; }
                    }
                }
                let mut db_conn: Option<rusqlite::Connection> = None;
                let wm = matches!(write_mode.as_deref(), Some("rust"));
                if wm {
                    if let Some(path) = db_path {
                        if let Ok(conn) = rusqlite::Connection::open(path) {
                            let _ = conn.pragma_update(None, "journal_mode", &"WAL");
                            let _ = conn.pragma_update(None, "synchronous", &"OFF");
                            let _ = conn.busy_timeout(std::time::Duration::from_millis(60000));
                            db_conn = Some(conn);
                        }
                    }
                }
                state_opt = Some(State { masks, n1, n2, categories, meta_map, subset, write_mode: wm, db: db_conn, word_list_hash });
                let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ready).unwrap());
            }
            Msg::Work { start, end, jStart, jEnd } => {
                if let Some(ref state) = state_opt {
                    let mut handle = stdout.lock();
                    run_work_streaming(state, start, end, jStart, jEnd, &mut handle);
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "not initialized".into()}).unwrap());
                }
            }
        }
    }
}


